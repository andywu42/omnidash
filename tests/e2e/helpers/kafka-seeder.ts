/**
 * Kafka Seeder Helper for E2E Data-Flow Tests [OMN-6297]
 *
 * Publishes test events to local Redpanda (localhost:19092) so that
 * the omnidash read-model consumer can project them into the DB and
 * the pages can render the projected data.
 *
 * Uses KafkaJS directly — no omnidash server imports to keep tests
 * decoupled from the implementation.
 */

import { Kafka, Producer, CompressionTypes } from 'kafkajs';

const KAFKA_BROKERS = (process.env.KAFKA_BROKERS || 'localhost:19092').split(',');

let producer: Producer | null = null;

/**
 * Get or create a shared KafkaJS producer for the test suite.
 * Connects lazily on first call.
 */
export async function getProducer(): Promise<Producer> {
  if (producer) return producer;

  const kafka = new Kafka({
    clientId: 'omnidash-e2e-seeder',
    brokers: KAFKA_BROKERS,
    connectionTimeout: 5000,
    requestTimeout: 10000,
  });

  producer = kafka.producer();
  await producer.connect();
  return producer;
}

/**
 * Disconnect the shared producer. Call in afterAll().
 */
export async function disconnectProducer(): Promise<void> {
  if (producer) {
    await producer.disconnect();
    producer = null;
  }
}

/**
 * Seed a single Kafka event to a topic.
 *
 * @param topic - Full topic name (e.g., "onex.evt.omniclaude.agent-actions.v1")
 * @param event - The event payload (will be JSON-stringified)
 * @param key   - Optional message key for partitioning
 */
export async function seedEvent(
  topic: string,
  event: Record<string, unknown>,
  key?: string
): Promise<void> {
  const p = await getProducer();
  await p.send({
    topic,
    compression: CompressionTypes.None,
    messages: [
      {
        key: key ?? undefined,
        value: JSON.stringify(event),
        timestamp: String(Date.now()),
      },
    ],
  });
}

/**
 * Generate a unique marker string for asserting seeded data appears on pages.
 * Format: e2e-<suffix>-<timestamp>
 */
export function marker(suffix: string): string {
  return `e2e-${suffix}-${Date.now()}`;
}
