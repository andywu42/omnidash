// no-migration: OMN-4587 No schema change -- only controls which topics the consumer subscribes to at startup.
/**
 * Read-Model Consumer (OMN-2061, decomposed OMN-5192)
 *
 * Kafka consumer that projects events into the omnidash_analytics database.
 * Projection logic lives in server/consumers/read-model/ domain handlers.
 * This file is the thin orchestrator: Kafka lifecycle, dispatch, stats, watermarks.
 */

import { Kafka, Consumer, EachMessagePayload, KafkaMessage } from 'kafkajs';
import { resolveBrokers } from './bus-config.js';
import { TopicCatalogManager } from './topic-catalog-manager';
import { loadManifestTopics } from './services/topic-manifest-loader';
import { tryGetIntelligenceDb } from './storage';
import { sql } from 'drizzle-orm';
// OMN-5251: @shared/topics imports removed — topic list now driven by topics.yaml
import { createProjectionHandlers, deterministicCorrelationId } from './consumers/read-model/index';
import type { ProjectionHandler, ProjectionContext } from './consumers/read-model/index';

const isTestEnv = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';
const CONSUMER_GROUP_ID = process.env.READ_MODEL_CONSUMER_GROUP_ID || 'omnidash-read-model-v1';
const CLIENT_ID = process.env.READ_MODEL_CLIENT_ID || 'omnidash-read-model-consumer';
const RETRY_BASE_DELAY_MS = isTestEnv ? 20 : 2000;
const RETRY_MAX_DELAY_MS = isTestEnv ? 200 : 30000;
const MAX_RETRY_ATTEMPTS = isTestEnv ? 2 : 10;

// Topics this consumer subscribes to.
// OMN-5251: Single source of truth is now topics.yaml (loaded by topic-manifest-loader.ts).
// READ_MODEL_TOPICS is derived from the manifest at module load time.
// Fail-fast: if topics.yaml cannot be loaded, the process exits immediately.
export const READ_MODEL_TOPICS: readonly string[] = (() => {
  try {
    return loadManifestTopics();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[ReadModelConsumer] FATAL: Failed to load topics.yaml — cannot start without topic manifest.\n` +
        `  Error: ${msg}\n` +
        `  Ensure topics.yaml exists and is valid YAML (checked paths: TOPICS_MANIFEST_PATH env, ./topics.yaml, /app/topics.yaml).`
    );
    process.exit(1);
  }
})();

export interface ReadModelConsumerStats {
  isRunning: boolean;
  eventsProjected: number;
  errorsCount: number;
  lastProjectedAt: Date | null;
  topicStats: Record<string, { projected: number; errors: number }>;
  catalogSource: 'catalog' | 'fallback' | 'static';
  unsupportedCatalogTopics: string[];
}

/**
 * Read-Model Consumer — thin orchestrator (OMN-5192).
 * Handles Kafka lifecycle, message dispatch, stats, and watermark tracking.
 * Projection logic is delegated to domain-specific handlers.
 */
export class ReadModelConsumer {
  private kafka: Kafka | null = null;
  private consumer: Consumer | null = null;
  private running = false;
  private stopped = false;
  private catalogManager: TopicCatalogManager | null = null;
  private catalogSource: 'catalog' | 'fallback' | 'static' = 'fallback';
  private handlers: ProjectionHandler[] = createProjectionHandlers();
  private stats: ReadModelConsumerStats = {
    isRunning: false,
    eventsProjected: 0,
    errorsCount: 0,
    lastProjectedAt: null,
    topicStats: {},
    catalogSource: 'fallback',
    unsupportedCatalogTopics: [],
  };

  /** Start the consumer. Fire-and-forget: caller must NOT await this. */
  async start(): Promise<void> {
    this.stopped = false;
    if (this.stopped) return;
    if (this.running) {
      console.log('[ReadModelConsumer] Already running');
      return;
    }
    this.stopped = false;

    let brokers: string[];
    try {
      brokers = resolveBrokers();
    } catch {
      console.warn('[ReadModelConsumer] No Kafka brokers configured -- skipping');
      return;
    }
    if (!tryGetIntelligenceDb()) {
      console.warn('[ReadModelConsumer] Database not configured -- skipping');
      return;
    }

    let attempts = 0;
    while (attempts < MAX_RETRY_ATTEMPTS) {
      if (this.stopped) return;
      try {
        this.kafka = new Kafka({
          clientId: CLIENT_ID,
          brokers,
          connectionTimeout: 10000,
          requestTimeout: 30000,
          retry: {
            initialRetryTime: RETRY_BASE_DELAY_MS,
            maxRetryTime: RETRY_MAX_DELAY_MS,
            retries: 10,
          },
        });
        this.consumer = this.kafka.consumer({
          groupId: CONSUMER_GROUP_ID,
          sessionTimeout: 30000,
          heartbeatInterval: 10000,
        });
        this.consumer.on(this.consumer.events.DISCONNECT, () => {
          if (!this.stopped)
            console.warn('[ReadModelConsumer] Kafka broker disconnected -- will reconnect');
        });
        await this.consumer.connect();
        console.log('[ReadModelConsumer] Connected to Kafka');

        // -----------------------------------------------------------------------
        // Topic subscription (OMN-5251 — topics.yaml is the single source of truth)
        //
        // READ_MODEL_TOPICS is populated from topics.yaml at module load time.
        // No fallback: if topics.yaml is missing or invalid, the process exits
        // at import time before reaching this code path.
        // -----------------------------------------------------------------------
        const finalTopics: string[] = [...READ_MODEL_TOPICS];
        this.catalogSource = 'manifest' as 'catalog' | 'fallback';
        this.stats.catalogSource = 'manifest' as typeof this.stats.catalogSource;
        console.info(`[read-model] topic source: manifest (subscribed=${finalTopics.length})`);

        const subscribedTopics: string[] = [];
        const skippedTopics: string[] = [];
        for (const topic of finalTopics) {
          try {
            // OMN-6393: Intentionally set to true so the consumer replays all events
            // still within Kafka's retention window on startup (or after a consumer
            // group reset). All projection handlers are idempotent (ON CONFLICT DO
            // UPDATE / DO NOTHING), so replay is safe. This was previously false,
            // which caused 56 of 70 tables to remain empty since historical events
            // were never projected.
            await this.consumer.subscribe({ topic, fromBeginning: true });
            subscribedTopics.push(topic);
          } catch (e) {
            skippedTopics.push(topic);
            console.warn(
              `[ReadModelConsumer] Skipping topic "${topic}":`,
              e instanceof Error ? e.message : e
            );
          }
        }
        if (subscribedTopics.length === 0)
          throw new Error(`No topics subscribed: ${skippedTopics.join(', ')}`);
        if (skippedTopics.length > 0)
          console.warn(
            `[ReadModelConsumer] Skipped ${skippedTopics.length} topic(s): ${skippedTopics.join(', ')}`
          );

        this.running = true;
        this.stats.isRunning = true;
        console.log(
          `[ReadModelConsumer] Running. Topics (${subscribedTopics.length}): ${subscribedTopics.join(', ')}. Group: ${CONSUMER_GROUP_ID}`
        );

        // Fire-and-forget consumer.run() -- kafkajs resolves immediately (OMN-2789)
        this.consumer
          .run({
            eachMessage: async (p: EachMessagePayload) => {
              await this.handleMessage(p);
            },
          })
          .catch((runErr) => {
            if (!this.stopped) {
              console.error(
                '[ReadModelConsumer] consumer.run() threw:',
                runErr instanceof Error ? runErr.message : runErr
              );
              this.running = false;
              this.stats.isRunning = false;
            }
          });

        // Block while consumer is alive
        while (this.running && !this.stopped) await new Promise((r) => setTimeout(r, 1000));
        if (this.stopped) return;

        // Fetch loop exited (crash) -- clean up and retry
        console.warn('[ReadModelConsumer] Consumer fetch loop exited -- retrying...');
        try {
          await this.consumer.disconnect();
        } catch {
          /* swallow */
        }
        this.consumer = null;
        this.kafka = null;
        attempts = 0;
        await new Promise((r) => setTimeout(r, RETRY_BASE_DELAY_MS));
        if (this.stopped) return;
        continue;
      } catch (err) {
        if (this.consumer) {
          try {
            await this.consumer.disconnect();
          } catch {
            /* swallow */
          }
          this.consumer = null;
          this.kafka = null;
        }
        this.running = false;
        this.stats.isRunning = false;
        attempts++;
        const delay = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempts), RETRY_MAX_DELAY_MS);
        console.error(
          `[ReadModelConsumer] Attempt ${attempts}/${MAX_RETRY_ATTEMPTS} failed:`,
          err instanceof Error ? err.message : err
        );
        if (attempts < MAX_RETRY_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, delay));
          if (this.stopped) return;
        }
      }
    }
    console.error('[ReadModelConsumer] Failed to connect after max retries');
  }

  /** Stop the consumer gracefully. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (!this.running && !this.consumer) return;
    if (this.catalogManager) {
      await this.catalogManager.stop().catch(() => {});
      this.catalogManager = null;
    }
    try {
      if (this.consumer) await this.consumer.disconnect();
      console.log('[ReadModelConsumer] Disconnected');
    } catch (err) {
      console.error('[ReadModelConsumer] Error during disconnect:', err);
    } finally {
      this.running = false;
      this.stats.isRunning = false;
      this.consumer = null;
      this.kafka = null;
    }
  }

  /**
   * @deprecated (OMN-5251) Legacy catalog fetch — no longer used on primary path.
   * Topic truth is now topics.yaml (loaded at module init via READ_MODEL_TOPICS).
   * Retained only for fetchCatalogTopics() in legacy code paths.
   */
  private async fetchCatalogTopics(): Promise<string[]> {
    this.catalogSource = 'fallback';
    this.stats.catalogSource = 'fallback';
    this.stats.unsupportedCatalogTopics = [];
    try {
      const manager = new TopicCatalogManager();
      this.catalogManager = manager;
      const topics = await new Promise<string[]>((resolve) => {
        manager.once('catalogReceived', (event) => {
          this.catalogSource = 'catalog';
          this.stats.catalogSource = 'catalog';
          resolve(event.topics);
        });
        manager.once('catalogTimeout', () => {
          console.warn('[ReadModelConsumer] Topic catalog timed out');
          manager.stop().catch(() => {});
          this.catalogManager = null;
          resolve([]);
        });
        manager.bootstrap().catch((err) => {
          console.warn('[ReadModelConsumer] Catalog bootstrap error:', err);
          manager.stop().catch(() => {});
          this.catalogManager = null;
          resolve([]);
        });
      });
      return topics;
    } catch (err) {
      console.warn('[ReadModelConsumer] fetchCatalogTopics error:', err);
      this.catalogManager = null;
      return [];
    }
  }

  getStats(): ReadModelConsumerStats {
    return { ...this.stats };
  }

  /** Dispatch incoming Kafka message to the matching projection handler. */
  private async handleMessage(payload: EachMessagePayload): Promise<void> {
    const { topic, partition, message } = payload;
    try {
      const parsed = this.parseMessage(message);
      if (!parsed) return;

      const fallbackId = deterministicCorrelationId(topic, partition, message.offset);
      const db = tryGetIntelligenceDb();
      const context: ProjectionContext = { db: db ?? null };
      const meta = { partition, offset: message.offset, fallbackId };

      let projected = false;
      for (const handler of this.handlers) {
        if (handler.canHandle(topic)) {
          projected = await handler.projectEvent(topic, parsed, context, meta);
          break;
        }
      }

      if (!projected) {
        const anyHandlerKnows = this.handlers.some((h) => h.canHandle(topic));
        if (!anyHandlerKnows) {
          console.warn(`[ReadModelConsumer] Unknown topic "${topic}" -- skipping`);
          return;
        }
        console.warn(
          `[ReadModelConsumer] DB unavailable, skipping ${topic} partition=${partition} offset=${message.offset}`
        );
        return;
      }

      this.stats.eventsProjected++;
      this.stats.lastProjectedAt = new Date();
      if (!this.stats.topicStats[topic]) this.stats.topicStats[topic] = { projected: 0, errors: 0 };
      this.stats.topicStats[topic].projected++;
      await this.updateWatermark(`${topic}:${partition}`, Number(message.offset));
    } catch (err) {
      this.stats.errorsCount++;
      if (!this.stats.topicStats[topic]) this.stats.topicStats[topic] = { projected: 0, errors: 0 };
      this.stats.topicStats[topic].errors++;
      console.error(
        `[ReadModelConsumer] Error projecting ${topic}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  private parseMessage(message: KafkaMessage): Record<string, unknown> | null {
    if (!message.value) return null;
    try {
      const raw = JSON.parse(message.value.toString());
      // Unwrap ONEX envelope: { payload: { ... } } or { data: { ... } }
      // Many producers use 'payload', others use 'data' as the envelope key.
      if (raw.payload && typeof raw.payload === 'object') return { ...raw.payload, _envelope: raw };
      if (raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data)) {
        // Heuristic: if 'data' contains domain fields (not just metadata), unwrap it.
        // Preserve envelope-level fields like event_type, correlation_id as fallbacks.
        return {
          ...raw.data,
          _envelope: raw,
          _event_type: raw.event_type,
          _correlation_id: raw.correlation_id,
        };
      }
      return raw;
    } catch {
      return null;
    }
  }

  private async updateWatermark(projectionName: string, offset: number): Promise<void> {
    const db = tryGetIntelligenceDb();
    if (!db) return;
    try {
      await db.execute(sql`
        INSERT INTO projection_watermarks (projection_name, last_offset, events_projected, updated_at)
        VALUES (${projectionName}, ${offset}, 1, NOW())
        ON CONFLICT (projection_name) DO UPDATE SET
          last_offset = GREATEST(projection_watermarks.last_offset, EXCLUDED.last_offset),
          events_projected = projection_watermarks.events_projected + 1,
          last_projected_at = NOW(), updated_at = NOW()
      `);
    } catch (err) {
      console.warn(
        '[ReadModelConsumer] Failed to update watermark:',
        err instanceof Error ? err.message : err
      );
    }
  }
}

// Singleton instance
export const readModelConsumer = new ReadModelConsumer();
