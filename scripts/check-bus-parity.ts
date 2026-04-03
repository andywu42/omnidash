/* eslint-disable no-console */
/**
 * scripts/check-bus-parity.ts
 *
 * Bus parity check script (OMN-4777).
 * Compares Kafka topic high-watermarks between local and cloud buses.
 *
 * Usage:
 *   npm run check:bus-parity
 *
 * Environment:
 *   KAFKA_LOCAL_BOOTSTRAP_SERVERS  — local bus (default: localhost:19092)
 *   KAFKA_CLOUD_BOOTSTRAP_SERVERS  — cloud bus (default: localhost:29092) # cloud-bus-ok OMN-4777
 *   PARITY_TOPICS                  — comma-separated topic list (optional override)
 *   PARITY_TIMEOUT_MS              — per-bus connection timeout in ms (default: 5000)
 *
 * Exit code: 0 always (unreachable buses are non-fatal; reported as UNREACHABLE)
 */

import { Kafka } from 'kafkajs';
import { config } from 'dotenv';
import { homedir } from 'os';
import { join } from 'path';

// Load platform env (optional; script is standalone)
config({ override: false });
config({ path: join(homedir(), '.omnibase', '.env'), override: false });

const DEFAULT_LOCAL_BROKERS = 'localhost:19092';
const DEFAULT_CLOUD_BROKERS = 'localhost:29092'; // # cloud-bus-ok OMN-4777

const DEFAULT_TOPICS = [
  'onex.evt.omniclaude.session-started.v1',
  'onex.evt.omniclaude.prompt-submitted.v1',
  'onex.evt.omniclaude.tool-executed.v1',
  'agent-actions',
  'agent-routing-decisions',
];

type TopicOffsets = Map<string, number | 'UNREACHABLE' | 'NOT_FOUND'>;

async function fetchOffsets(
  brokerString: string,
  topics: string[],
  timeoutMs: number,
  busLabel: string
): Promise<TopicOffsets> {
  const result: TopicOffsets = new Map();

  const kafka = new Kafka({
    brokers: brokerString.split(','),
    clientId: `omnidash-parity-check-${busLabel}`,
    connectionTimeout: timeoutMs,
    requestTimeout: timeoutMs,
    retry: { retries: 1, initialRetryTime: 500 },
  });

  const admin = kafka.admin();

  try {
    await admin.connect();

    for (const topic of topics) {
      try {
        const offsets = await admin.fetchTopicOffsets(topic);
        // Sum high-watermarks across all partitions
        const total = offsets.reduce((sum, p) => sum + parseInt(p.high, 10), 0);
        result.set(topic, total);
      } catch {
        result.set(topic, 'NOT_FOUND');
      }
    }

    await admin.disconnect();
  } catch {
    // Bus unreachable — mark all topics as UNREACHABLE
    for (const topic of topics) {
      result.set(topic, 'UNREACHABLE');
    }
    try {
      await admin.disconnect();
    } catch {
      // ignore
    }
  }

  return result;
}

async function main(): Promise<void> {
  const localBrokers = process.env.KAFKA_LOCAL_BOOTSTRAP_SERVERS ?? DEFAULT_LOCAL_BROKERS;
  const cloudBrokers = process.env.KAFKA_CLOUD_BOOTSTRAP_SERVERS ?? DEFAULT_CLOUD_BROKERS; // # cloud-bus-ok OMN-4777
  const timeoutMs = parseInt(process.env.PARITY_TIMEOUT_MS ?? '5000', 10);

  const topicsRaw = process.env.PARITY_TOPICS;
  const topics = topicsRaw ? topicsRaw.split(',').map((t) => t.trim()) : DEFAULT_TOPICS;

  console.log('');
  console.log('Bus Parity Check');
  console.log('═════════════════════════════════════════════════════');
  console.log(`  Local bus:  ${localBrokers}`);
  console.log(`  Cloud bus:  ${cloudBrokers}`); // # cloud-bus-ok OMN-4777
  console.log(`  Timeout:    ${timeoutMs}ms`);
  console.log(`  Topics:     ${topics.length}`);
  console.log('');

  const [localOffsets, cloudOffsets] = await Promise.all([
    fetchOffsets(localBrokers, topics, timeoutMs, 'local'),
    fetchOffsets(cloudBrokers, topics, timeoutMs, 'cloud'), // # cloud-bus-ok OMN-4777
  ]);

  let divergeCount = 0;

  console.log(`${'Topic'.padEnd(50)} ${'Local'.padStart(12)} ${'Cloud'.padStart(12)}  Status`);
  console.log('─'.repeat(85));

  for (const topic of topics) {
    const local = localOffsets.get(topic) ?? 'UNREACHABLE';
    const cloud = cloudOffsets.get(topic) ?? 'UNREACHABLE'; // # cloud-bus-ok OMN-4777

    const localStr = typeof local === 'number' ? local.toLocaleString() : local;
    const cloudStr = typeof cloud === 'number' ? cloud.toLocaleString() : cloud; // # cloud-bus-ok OMN-4777

    let status: string;
    if (local === 'UNREACHABLE' || cloud === 'UNREACHABLE') {
      // # cloud-bus-ok OMN-4777
      status = '⚠ UNREACHABLE';
    } else if (local === 'NOT_FOUND' || cloud === 'NOT_FOUND') {
      // # cloud-bus-ok OMN-4777
      status = '— NOT FOUND';
    } else if (local === cloud) {
      // # cloud-bus-ok OMN-4777
      status = '= MATCH';
    } else {
      status = '≠ DIVERGE';
      divergeCount++;
    }

    const shortTopic = topic.length > 49 ? topic.slice(0, 46) + '...' : topic;
    console.log(
      `${shortTopic.padEnd(50)} ${localStr.padStart(12)} ${cloudStr.padStart(12)}  ${status}` // # cloud-bus-ok OMN-4777
    );
  }

  console.log('─'.repeat(85));
  console.log('');

  if (divergeCount > 0) {
    console.log(`Diverged topics: ${divergeCount} of ${topics.length}`);
  } else {
    console.log(`All topics match or unreachable (${topics.length} checked)`);
  }
  console.log('');
}

main().catch((err) => {
  console.error('[check-bus-parity] Unexpected error:', err);
  // Exit 0 — parity check is informational, never fatal
  process.exit(0);
});
