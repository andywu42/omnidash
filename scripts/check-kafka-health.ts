#!/usr/bin/env tsx
// Requires `tsx` (TypeScript Execute) -- listed in devDependencies of package.json.

/* eslint-disable no-console */

/**
 * Kafka Health Diagnostic
 *
 * Standalone script that checks every topic the omnidash event consumer
 * subscribes to, probes for recent messages, and prints a readable table
 * showing topic health, message counts, and freshness.
 *
 * Run:
 *   npx tsx scripts/check-kafka-health.ts
 *   # or with explicit broker:
 *   KAFKA_BROKERS=192.168.86.200:29092 npx tsx scripts/check-kafka-health.ts // # cloud-bus-ok OMN-4494
 */

import 'dotenv/config';
import { Kafka, logLevel } from 'kafkajs';
import {
  buildSubscriptionTopics,
  SUFFIX_INTELLIGENCE_TOOL_CONTENT,
  SUFFIX_OMNICLAUDE_SESSION_STARTED,
  SUFFIX_OMNICLAUDE_PROMPT_SUBMITTED,
  SUFFIX_OMNICLAUDE_TOOL_EXECUTED,
  SUFFIX_OMNICLAUDE_SESSION_ENDED,
  SUFFIX_INTELLIGENCE_CLAUDE_HOOK,
} from '@shared/topics';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BROKER =
  process.env.KAFKA_BROKERS ?? process.env.KAFKA_BOOTSTRAP_SERVERS ?? '192.168.86.200:29092'; // # cloud-bus-ok OMN-4494

const kafka = new Kafka({
  brokers: BROKER.split(','),
  clientId: 'omnidash-health-check',
  connectionTimeout: 5_000,
  requestTimeout: 10_000,
  logLevel: logLevel.ERROR,
});

const ONE_HOUR_MS = 60 * 60 * 1_000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TopicHealth {
  topic: string;
  group: string; // canonical | legacy-flat | dev-prefixed
  exists: boolean;
  partitions: number;
  messageCount: number;
  latestTimestamp: number | null;
  freshness: 'FRESH' | 'STALE' | 'EMPTY' | 'MISSING';
  sampleKeys: string[];
}

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

async function probeTopicHealth(topic: string, group: string): Promise<TopicHealth> {
  const result: TopicHealth = {
    topic,
    group,
    exists: false,
    partitions: 0,
    messageCount: 0,
    latestTimestamp: null,
    freshness: 'MISSING',
    sampleKeys: [],
  };

  const admin = kafka.admin();
  try {
    await admin.connect();

    // Check metadata
    let meta;
    try {
      meta = await admin.fetchTopicMetadata({ topics: [topic] });
    } catch {
      return result;
    }

    if (!meta.topics.length || !meta.topics[0].partitions.length) {
      return result;
    }
    result.exists = true;
    result.partitions = meta.topics[0].partitions.length;

    // Offsets
    const offsets = await admin.fetchTopicOffsets(topic);
    result.messageCount = offsets.reduce(
      (sum, o) => sum + (parseInt(o.high, 10) - parseInt(o.low, 10)),
      0
    );

    if (result.messageCount === 0) {
      result.freshness = 'EMPTY';
      return result;
    }

    // Read latest message from partition 0
    const latestMsg = await readLatest(topic);
    if (latestMsg) {
      result.latestTimestamp = latestMsg.timestamp;
      result.sampleKeys = latestMsg.keys;
      const age = Date.now() - latestMsg.timestamp;
      result.freshness = age < ONE_HOUR_MS ? 'FRESH' : 'STALE';
    } else {
      result.freshness = 'STALE';
    }

    return result;
  } catch {
    return result;
  } finally {
    await admin.disconnect();
  }
}

async function readLatest(topic: string): Promise<{ timestamp: number; keys: string[] } | null> {
  const groupId = `health-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const consumer = kafka.consumer({ groupId, maxWaitTimeInMs: 5_000 });
  const admin = kafka.admin();
  let consumerConnected = false;

  try {
    await admin.connect();
    const offsets = await admin.fetchTopicOffsets(topic);

    const p0 = offsets.find((o) => o.partition === 0);
    if (!p0 || parseInt(p0.high, 10) === 0) return null;

    const seekOffset = Math.max(0, parseInt(p0.high, 10) - 1);

    await consumer.connect();
    consumerConnected = true;
    await consumer.subscribe({ topic, fromBeginning: false });

    return await new Promise<{ timestamp: number; keys: string[] } | null>((resolve) => {
      const timeout = setTimeout(() => resolve(null), 6_000);

      consumer.run({
        eachMessage: async ({ message }) => {
          clearTimeout(timeout);
          const ts = message.timestamp ? parseInt(message.timestamp, 10) : Date.now();
          let keys: string[] = [];
          if (message.value) {
            try {
              const parsed = JSON.parse(message.value.toString('utf-8'));
              if (typeof parsed === 'object' && parsed !== null) {
                keys = Object.keys(parsed).slice(0, 6);
              }
            } catch {
              keys = ['(non-JSON)'];
            }
          }
          resolve({ timestamp: ts, keys });
        },
      });

      consumer.seek({ topic, partition: 0, offset: String(seekOffset) });
    });
  } catch {
    return null;
  } finally {
    try {
      if (consumerConnected) {
        await consumer.stop();
        await consumer.disconnect();
      }
    } catch {
      // best-effort consumer cleanup
    }
    try {
      // Clean up the ephemeral consumer group to avoid leaking groups on the broker.
      // Only attempt if the consumer was connected (group may not exist otherwise).
      if (consumerConnected) {
        await admin.deleteGroups([groupId]);
      }
    } catch {
      // best-effort group cleanup — group may already be gone
    }
    try {
      await admin.disconnect();
    } catch {
      // best-effort admin cleanup
    }
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function pad(s: string, len: number): string {
  return s.length >= len ? s.slice(0, len) : s + ' '.repeat(len - s.length);
}

function rpad(s: string, len: number): string {
  return s.length >= len ? s.slice(0, len) : ' '.repeat(len - s.length) + s;
}

function formatAge(ts: number | null): string {
  if (ts === null) return '-';
  const ageMs = Date.now() - ts;
  if (ageMs < 60_000) return `${(ageMs / 1_000).toFixed(0)}s ago`;
  if (ageMs < ONE_HOUR_MS) return `${(ageMs / 60_000).toFixed(1)}m ago`;
  if (ageMs < ONE_DAY_MS) return `${(ageMs / ONE_HOUR_MS).toFixed(1)}h ago`;
  return `${(ageMs / ONE_DAY_MS).toFixed(1)}d ago`;
}

function freshnessIcon(f: TopicHealth['freshness']): string {
  switch (f) {
    case 'FRESH':
      return 'OK';
    case 'STALE':
      return 'STALE';
    case 'EMPTY':
      return 'EMPTY';
    case 'MISSING':
      return 'MISS';
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('='.repeat(100));
  console.log('  KAFKA HEALTH DIAGNOSTIC');
  console.log(`  Broker: ${BROKER}`);
  console.log(`  Time:   ${new Date().toISOString()}`);
  console.log('='.repeat(100));

  // 1. Connectivity check
  const admin = kafka.admin();
  try {
    await admin.connect();
    console.log('\nConnectivity: OK\n');
  } catch (err) {
    console.error(`\nConnectivity: FAILED -- ${err instanceof Error ? err.message : err}`);
    console.error('Cannot reach Kafka broker. Exiting.');
    process.exit(1);
  }

  // 2. List all broker topics
  const allBrokerTopics = await admin.listTopics();
  await admin.disconnect();

  console.log(`Total topics on broker: ${allBrokerTopics.length}\n`);

  // 3. Build our subscription list
  const subscriptionTopics = buildSubscriptionTopics();
  const canonicalTopics = subscriptionTopics.filter((t) => t.startsWith('onex.'));
  const legacyFlatTopics = subscriptionTopics.filter((t) => !t.startsWith('onex.'));

  // Also discover dev-prefixed versions of canonical topics
  const devPrefixedTopics = canonicalTopics
    .map((t) => `dev.${t}`)
    .filter((t) => allBrokerTopics.includes(t));

  // 4. Probe each topic
  const results: TopicHealth[] = [];

  console.log('Probing canonical ONEX topics...');
  for (const topic of canonicalTopics) {
    process.stdout.write(`  ${topic} ... `);
    const h = await probeTopicHealth(topic, 'canonical');
    results.push(h);
    console.log(freshnessIcon(h.freshness));
  }

  console.log('\nProbing legacy flat topics...');
  for (const topic of legacyFlatTopics) {
    process.stdout.write(`  ${topic} ... `);
    const h = await probeTopicHealth(topic, 'legacy-flat');
    results.push(h);
    console.log(freshnessIcon(h.freshness));
  }

  console.log('\nProbing dev-prefixed variants...');
  if (devPrefixedTopics.length === 0) {
    console.log('  (none found on broker)');
  }
  for (const topic of devPrefixedTopics) {
    process.stdout.write(`  ${topic} ... `);
    const h = await probeTopicHealth(topic, 'dev-prefixed');
    results.push(h);
    console.log(freshnessIcon(h.freshness));
  }

  // Also check well-known dev-prefixed topics that may not be in the subscription list
  const knownDevTopics = [
    `dev.${SUFFIX_INTELLIGENCE_TOOL_CONTENT}`,
    `dev.${SUFFIX_INTELLIGENCE_CLAUDE_HOOK}`,
    `dev.${SUFFIX_OMNICLAUDE_SESSION_STARTED}`,
    `dev.${SUFFIX_OMNICLAUDE_PROMPT_SUBMITTED}`,
    `dev.${SUFFIX_OMNICLAUDE_TOOL_EXECUTED}`,
    `dev.${SUFFIX_OMNICLAUDE_SESSION_ENDED}`,
  ];
  const extraDevTopics = knownDevTopics.filter(
    (t) => allBrokerTopics.includes(t) && !devPrefixedTopics.includes(t)
  );
  if (extraDevTopics.length > 0) {
    console.log('\nProbing additional known dev-prefixed topics...');
    for (const topic of extraDevTopics) {
      process.stdout.write(`  ${topic} ... `);
      const h = await probeTopicHealth(topic, 'dev-prefixed');
      results.push(h);
      console.log(freshnessIcon(h.freshness));
    }
  }

  // 5. Print summary table
  console.log('\n' + '='.repeat(100));
  console.log('  TOPIC HEALTH TABLE');
  console.log('='.repeat(100));

  const colTopic = 62;
  const colStatus = 7;
  const colMsgs = 8;
  const colAge = 12;

  console.log(
    `${pad('TOPIC', colTopic)} ${pad('STATUS', colStatus)} ${rpad('MSGS', colMsgs)} ${pad('LAST MSG', colAge)}`
  );
  console.log('-'.repeat(100));

  // Sort: canonical first, then legacy-flat, then dev-prefixed. Within each group, sort by name.
  const groupOrder: Record<string, number> = { canonical: 0, 'legacy-flat': 1, 'dev-prefixed': 2 };
  results.sort((a, b) => {
    const ga = groupOrder[a.group] ?? 3;
    const gb = groupOrder[b.group] ?? 3;
    if (ga !== gb) return ga - gb;
    return a.topic.localeCompare(b.topic);
  });

  let currentGroup = '';
  for (const r of results) {
    if (r.group !== currentGroup) {
      currentGroup = r.group;
      console.log(`\n  [${currentGroup.toUpperCase()}]`);
    }
    console.log(
      `${pad(r.topic, colTopic)} ${pad(freshnessIcon(r.freshness), colStatus)} ${rpad(String(r.messageCount), colMsgs)} ${pad(formatAge(r.latestTimestamp), colAge)}`
    );
  }

  // 6. Diagnosis section
  console.log('\n' + '='.repeat(100));
  console.log('  DIAGNOSIS');
  console.log('='.repeat(100));

  const canonical = results.filter((r) => r.group === 'canonical');
  const devPrefixed = results.filter((r) => r.group === 'dev-prefixed');
  const legacyFlat = results.filter((r) => r.group === 'legacy-flat');

  const canonicalFresh = canonical.filter((r) => r.freshness === 'FRESH');
  const canonicalEmpty = canonical.filter(
    (r) => r.freshness === 'EMPTY' || r.freshness === 'MISSING'
  );
  const devWithData = devPrefixed.filter((r) => r.messageCount > 0);
  const legacyFresh = legacyFlat.filter((r) => r.freshness === 'FRESH');

  console.log(
    `\nCanonical topics: ${canonicalFresh.length}/${canonical.length} fresh, ${canonicalEmpty.length} empty/missing`
  );
  console.log(`Dev-prefixed:     ${devWithData.length} have data`);
  console.log(`Legacy flat:      ${legacyFresh.length}/${legacyFlat.length} fresh`);

  // Check for the key diagnostic: events in dev-prefixed but not canonical
  const misrouted: string[] = [];
  for (const c of canonicalEmpty) {
    const devVersion = results.find(
      (r) => r.group === 'dev-prefixed' && r.topic === `dev.${c.topic}` && r.messageCount > 0
    );
    if (devVersion) {
      misrouted.push(c.topic);
    }
  }

  if (misrouted.length > 0) {
    console.log(`\nMISROUTED TOPICS (events going to dev.* instead of canonical):`);
    for (const t of misrouted) {
      console.log(`  - ${t}  -->  dev.${t}`);
    }
    console.log(
      '\nFIX: Update the hook/producer to emit to the canonical topic name (without dev. prefix).'
    );
  } else if (canonicalEmpty.length > 0 && devWithData.length === 0) {
    console.log('\nNo misrouted topics found, but some canonical topics are empty.');
    console.log('This may mean the producers for those topics are not running.');
  } else {
    console.log('\nNo misrouting detected. Pipeline looks healthy.');
  }

  console.log('\n' + '='.repeat(100) + '\n');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
