// no-migration: OMN-6971 Adds a periodic heartbeat emitter that writes to the existing consumer_health_events table; no schema change.
/**
 * Consumer Health Heartbeat (OMN-6971)
 *
 * Periodic self-reporting emitter for the omnidash read-model consumer.
 * Publishes one heartbeat event per interval to
 *   onex.evt.omnibase-infra.consumer-health.v1
 * with consumer_group, topics_subscribed, current_lag, and status derived from
 * ReadModelConsumer.getStats().
 *
 * The event is projected back into consumer_health_events by the existing
 * OmnibaseInfraProjectionHandler.projectConsumerHealth handler, which means
 * the consumer_health_events table is populated from omnidash's own liveness
 * loop (DoD: >0 rows within 2 minutes of start).
 *
 * Interval is configurable via CONSUMER_HEALTH_HEARTBEAT_INTERVAL_MS
 * (default 60000). Setting it to 0 disables the emitter.
 */

import { Kafka, Producer } from 'kafkajs';
import { randomUUID } from 'crypto';
import os from 'os';
import { resolveBrokers } from './bus-config.js';
import { TOPIC_OMNIBASE_INFRA_CONSUMER_HEALTH } from '@shared/topics';
import { readModelConsumer } from './read-model-consumer';
import type { ReadModelConsumerStats } from './read-model-consumer';

const DEFAULT_INTERVAL_MS = 60_000;
const CLIENT_ID = 'omnidash-consumer-health-heartbeat';
const CONSUMER_IDENTITY =
  process.env.READ_MODEL_CLIENT_ID || 'omnidash-read-model-consumer';
const CONSUMER_GROUP_ID =
  process.env.READ_MODEL_CONSUMER_GROUP_ID || 'omnidash-read-model-v1';
const SERVICE_LABEL = process.env.SERVICE_LABEL || 'omnidash';

function parseInterval(): number {
  const raw = process.env.CONSUMER_HEALTH_HEARTBEAT_INTERVAL_MS;
  if (raw == null || raw === '') return DEFAULT_INTERVAL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_INTERVAL_MS;
  return Math.floor(n);
}

/**
 * Build the heartbeat payload from the current ReadModelConsumer stats.
 * Exported for unit tests — pure function, no side effects.
 */
export function buildHeartbeatPayload(
  stats: ReadModelConsumerStats,
  topicsSubscribed: readonly string[],
  now: Date = new Date()
): Record<string, unknown> {
  const status = stats.isRunning ? 'INFO' : 'WARNING';
  const eventType = stats.isRunning ? 'CONSUMER_HEARTBEAT' : 'HEARTBEAT_FAILURE';
  const totalErrors = stats.errorsCount;

  return {
    event_id: randomUUID(),
    consumer_identity: CONSUMER_IDENTITY,
    consumer_group: CONSUMER_GROUP_ID,
    topic: TOPIC_OMNIBASE_INFRA_CONSUMER_HEALTH,
    event_type: eventType,
    severity: status,
    fingerprint: `${CONSUMER_IDENTITY}:${eventType}`,
    error_message: '',
    error_type: '',
    hostname: os.hostname(),
    service_label: SERVICE_LABEL,
    topics_subscribed: [...topicsSubscribed],
    events_projected: stats.eventsProjected,
    current_lag: totalErrors,
    status: stats.isRunning ? 'healthy' : 'degraded',
    emitted_at: now.toISOString(),
  };
}

export class ConsumerHealthHeartbeat {
  private kafka: Kafka | null = null;
  private producer: Producer | null = null;
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private readonly intervalMs: number;

  constructor(intervalMs: number = parseInterval()) {
    this.intervalMs = intervalMs;
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.intervalMs === 0) {
      console.log('[ConsumerHealthHeartbeat] Disabled (interval=0)');
      return;
    }

    let brokers: string[];
    try {
      brokers = resolveBrokers();
    } catch {
      console.warn('[ConsumerHealthHeartbeat] No Kafka brokers configured -- skipping');
      return;
    }

    this.kafka = new Kafka({
      clientId: CLIENT_ID,
      brokers,
      connectionTimeout: 10_000,
      requestTimeout: 30_000,
      retry: { initialRetryTime: 1_000, maxRetryTime: 30_000, retries: 10 },
    });
    this.producer = this.kafka.producer();

    try {
      await this.producer.connect();
    } catch (err) {
      console.error(
        '[ConsumerHealthHeartbeat] Failed to connect producer:',
        err instanceof Error ? err.message : err
      );
      this.producer = null;
      this.kafka = null;
      return;
    }

    this.started = true;
    console.log(
      `[ConsumerHealthHeartbeat] Running (interval=${this.intervalMs}ms, topic=${TOPIC_OMNIBASE_INFRA_CONSUMER_HEALTH})`
    );

    // Emit one immediately so the table has a row well before the first interval.
    void this.emitOnce();
    this.timer = setInterval(() => void this.emitOnce(), this.intervalMs);
    // Don't keep the Node event loop alive solely for the heartbeat.
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.producer) {
      try {
        await this.producer.disconnect();
      } catch (err) {
        console.warn(
          '[ConsumerHealthHeartbeat] Error during producer disconnect:',
          err instanceof Error ? err.message : err
        );
      }
    }
    this.producer = null;
    this.kafka = null;
    this.started = false;
  }

  /** Emit a single heartbeat. Exported-ish via isStarted for tests. */
  async emitOnce(): Promise<void> {
    if (!this.producer) return;
    try {
      const stats = readModelConsumer.getStats();
      const topicsSubscribed = Object.keys(stats.topicStats);
      const payload = buildHeartbeatPayload(stats, topicsSubscribed);
      const envelope = {
        event_id: payload.event_id,
        event_type: payload.event_type,
        source: SERVICE_LABEL,
        timestamp: payload.emitted_at,
        payload,
      };
      await this.producer.send({
        topic: TOPIC_OMNIBASE_INFRA_CONSUMER_HEALTH,
        messages: [
          {
            key: String(payload.consumer_identity),
            value: JSON.stringify(envelope),
          },
        ],
      });
    } catch (err) {
      console.warn(
        '[ConsumerHealthHeartbeat] emit failed:',
        err instanceof Error ? err.message : err
      );
    }
  }

  get isStarted(): boolean {
    return this.started;
  }
}

export const consumerHealthHeartbeat = new ConsumerHealthHeartbeat();
