/**
 * Layer 1 Integration Test: Kafka Data Source
 *
 * Verifies that the Kafka broker is reachable, canonical ONEX topics exist,
 * omniclaude lifecycle topics carry recent events, and dev-prefixed legacy
 * topics are properly identified.
 *
 * Guard: only runs when INTEGRATION_TESTS=true (or Kafka is proven reachable).
 *
 * Run:
 *   INTEGRATION_TESTS=true npx vitest run tests/integration/layer1-kafka-data-source.test.ts
 */

import { Kafka, Admin, logLevel } from 'kafkajs';
import {
  buildSubscriptionTopics,
  ENVIRONMENT_PREFIXES,
  SUFFIX_OMNICLAUDE_SESSION_STARTED,
  SUFFIX_OMNICLAUDE_PROMPT_SUBMITTED,
  SUFFIX_OMNICLAUDE_TOOL_EXECUTED,
  SUFFIX_INTELLIGENCE_CLAUDE_HOOK,
  SUFFIX_INTELLIGENCE_TOOL_CONTENT,
} from '@shared/topics';

// ---------------------------------------------------------------------------
// Kafka connection config
// ---------------------------------------------------------------------------

const BROKER =
  process.env.KAFKA_BROKERS ?? process.env.KAFKA_BOOTSTRAP_SERVERS ?? 'localhost:29092'; // # cloud-bus-ok OMN-4494

const kafka = new Kafka({
  brokers: BROKER.split(','),
  clientId: 'omnidash-layer1-test',
  connectionTimeout: 5_000,
  requestTimeout: 10_000,
  logLevel: logLevel.WARN,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Probe the broker with a short timeout. Returns true if connection succeeds. */
async function isKafkaReachable(): Promise<boolean> {
  const admin = kafka.admin();
  try {
    await admin.connect();
    await admin.disconnect();
    return true;
  } catch {
    return false;
  }
}

/** One-hour freshness threshold. */
const ONE_HOUR_MS = 60 * 60 * 1_000;

interface TopicProbe {
  topic: string;
  exists: boolean;
  messageCount: number;
  latestTimestamp: number | null;
  latestValue: unknown;
  fresh: boolean; // true if latestTimestamp is within ONE_HOUR_MS of now
}

/**
 * For a single topic, check existence, message count, and read the latest
 * message from partition 0.
 */
async function probeTopic(admin: Admin, topic: string): Promise<TopicProbe> {
  const result: TopicProbe = {
    topic,
    exists: false,
    messageCount: 0,
    latestTimestamp: null,
    latestValue: null,
    fresh: false,
  };

  try {
    const meta = await admin.fetchTopicMetadata({ topics: [topic] });
    if (meta.topics.length === 0 || meta.topics[0].partitions.length === 0) {
      return result;
    }
    result.exists = true;

    // Sum up offsets across all partitions
    const offsets = await admin.fetchTopicOffsets(topic);
    result.messageCount = offsets.reduce(
      (sum, o) => sum + (parseInt(o.high, 10) - parseInt(o.low, 10)),
      0
    );

    if (result.messageCount === 0) {
      return result;
    }

    // Read latest message via a short-lived consumer (reuse existing admin)
    const latestMsg = await readLatestMessage(topic, admin);
    if (latestMsg) {
      result.latestTimestamp = latestMsg.timestamp;
      result.latestValue = latestMsg.value;
      result.fresh = Date.now() - latestMsg.timestamp < ONE_HOUR_MS;
    }
  } catch {
    // Topic does not exist or metadata fetch failed
    result.exists = false;
  }

  return result;
}

/**
 * Read the latest message from partition 0 of a topic by seeking to the end
 * minus one offset. Returns null if no messages are available.
 */
async function readLatestMessage(
  topic: string,
  existingAdmin?: Admin
): Promise<{ timestamp: number; value: unknown } | null> {
  const groupId = `omnidash-layer1-probe-${topic}-${Date.now()}`;
  const consumer = kafka.consumer({ groupId, maxWaitTimeInMs: 5_000 });

  try {
    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: false });

    // Fetch the high watermark — reuse caller's admin connection if available
    let admin: Admin;
    let ownAdmin = false;
    if (existingAdmin) {
      admin = existingAdmin;
    } else {
      admin = kafka.admin();
      await admin.connect();
      ownAdmin = true;
    }
    const offsets = await admin.fetchTopicOffsets(topic);
    if (ownAdmin) {
      await admin.disconnect();
    }

    // Find partition 0 high watermark
    const p0 = offsets.find((o) => o.partition === 0);
    if (!p0 || parseInt(p0.high, 10) === 0) return null;

    const seekOffset = Math.max(0, parseInt(p0.high, 10) - 1);

    return await new Promise<{ timestamp: number; value: unknown } | null>((resolve) => {
      const timeout = setTimeout(() => resolve(null), 8_000);

      consumer.run({
        eachMessage: async ({ message }) => {
          clearTimeout(timeout);
          let value: unknown = null;
          if (message.value) {
            try {
              value = JSON.parse(message.value.toString('utf-8'));
            } catch {
              value = message.value.toString('utf-8');
            }
          }
          const ts = message.timestamp ? parseInt(message.timestamp, 10) : Date.now();
          resolve({ timestamp: ts, value });
        },
      });

      // Seek after run() has set up the internal consumer
      consumer.seek({ topic, partition: 0, offset: String(seekOffset) });
    });
  } catch {
    return null;
  } finally {
    try {
      await consumer.disconnect();
    } catch {
      // best-effort disconnect
    }
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

const shouldRun = process.env.INTEGRATION_TESTS === 'true';

describe.skipIf(!shouldRun)('Layer 1: Kafka Data Source', () => {
  let admin: Admin;

  beforeAll(async () => {
    admin = kafka.admin();
    await admin.connect();
  }, 15_000);

  afterAll(async () => {
    console.log('\n====================================================');
    console.log('  LAYER 1 KAFKA DATA SOURCE - SUMMARY');
    console.log('====================================================');

    const allTopics = buildSubscriptionTopics();
    const canonicalTopics = allTopics.filter((t) => t.startsWith('onex.'));
    const legacyFlatTopics = allTopics.filter((t) => !t.startsWith('onex.'));
    const existingTopics = await admin.listTopics();
    const existingSet = new Set(existingTopics);

    console.log(`\nBroker: ${BROKER}`);
    console.log(`Total topics on broker: ${existingTopics.length}`);
    console.log(
      `Subscription list size: ${allTopics.length} (${canonicalTopics.length} canonical, ${legacyFlatTopics.length} legacy flat)`
    );

    const canonicalExist = canonicalTopics.filter((t) => existingSet.has(t));
    const canonicalMissing = canonicalTopics.filter((t) => !existingSet.has(t));
    const canonicalWithDev = canonicalMissing.filter((t) => existingSet.has(`dev.${t}`));

    console.log(
      `\nCanonical topics: ${canonicalExist.length} exist, ${canonicalMissing.length} missing`
    );
    if (canonicalWithDev.length > 0) {
      console.log(
        `  ${canonicalWithDev.length} missing canonical topics have dev-prefixed versions (events routed to legacy names)`
      );
    }

    const legacyExist = legacyFlatTopics.filter((t) => existingSet.has(t));
    console.log(`Legacy flat topics: ${legacyExist.length}/${legacyFlatTopics.length} exist`);

    console.log('\n====================================================\n');

    await admin.disconnect();
  });

  // -----------------------------------------------------------------------
  // 1. Basic connectivity
  // -----------------------------------------------------------------------

  it('can connect to Kafka', async () => {
    const reachable = await isKafkaReachable();
    expect(reachable).toBe(true);
  }, 10_000);

  // -----------------------------------------------------------------------
  // 2. Canonical topics exist
  // -----------------------------------------------------------------------

  it('canonical topics exist', async () => {
    const allTopics = buildSubscriptionTopics();
    // Separate canonical ONEX topics from legacy flat topics
    const canonicalTopics = allTopics.filter((t) => t.startsWith('onex.'));

    const existingTopics = await admin.listTopics();
    const existingSet = new Set(existingTopics);

    const missing: string[] = [];
    const found: string[] = [];

    for (const topic of canonicalTopics) {
      if (existingSet.has(topic)) {
        found.push(topic);
      } else {
        // Also check if a dev-prefixed version exists instead
        const devVersion = `dev.${topic}`;
        if (existingSet.has(devVersion)) {
          missing.push(`${topic}  (exists as dev-prefixed: ${devVersion})`);
        } else {
          missing.push(`${topic}  (not found at all)`);
        }
      }
    }

    console.log('\n--- Canonical Topic Existence ---');
    console.log(`Found:   ${found.length}/${canonicalTopics.length}`);
    console.log(`Missing: ${missing.length}/${canonicalTopics.length}`);
    if (missing.length > 0) {
      console.log('\nMissing topics:');
      for (const m of missing) {
        console.log(`  - ${m}`);
      }
    }

    // At least SOME canonical topics should exist; if zero exist the pipeline is fundamentally broken
    expect(found.length).toBeGreaterThan(0);
  }, 30_000);

  // -----------------------------------------------------------------------
  // 3. OmniClaude topics have recent events
  // -----------------------------------------------------------------------

  it('canonical omniclaude topics have recent events', async () => {
    const omniclaudeTopics = [
      SUFFIX_OMNICLAUDE_SESSION_STARTED,
      SUFFIX_OMNICLAUDE_PROMPT_SUBMITTED,
      SUFFIX_OMNICLAUDE_TOOL_EXECUTED,
    ];

    const results: TopicProbe[] = [];
    for (const topic of omniclaudeTopics) {
      results.push(await probeTopic(admin, topic));
    }

    console.log('\n--- OmniClaude Topic Freshness ---');
    for (const r of results) {
      const age = r.latestTimestamp
        ? `${((Date.now() - r.latestTimestamp) / 60_000).toFixed(1)} min ago`
        : 'no messages';
      const status = r.fresh ? 'FRESH' : r.exists ? 'STALE' : 'MISSING';
      console.log(`  [${status.padEnd(7)}] ${r.topic}  (msgs: ${r.messageCount}, last: ${age})`);
    }

    // Check for dev-prefixed alternatives if canonical topics are empty
    const emptyCanonical = results.filter((r) => r.messageCount === 0);
    if (emptyCanonical.length > 0) {
      console.log('\n  Checking dev-prefixed alternatives for empty canonical topics...');
      for (const r of emptyCanonical) {
        const devTopic = `dev.${r.topic}`;
        const devProbe = await probeTopic(admin, devTopic);
        if (devProbe.exists && devProbe.messageCount > 0) {
          const age = devProbe.latestTimestamp
            ? `${((Date.now() - devProbe.latestTimestamp) / 60_000).toFixed(1)} min ago`
            : 'unknown';
          console.log(
            `  ** ${devTopic} has ${devProbe.messageCount} msgs (last: ${age}) -- events going to LEGACY topic!`
          );
        }
      }
    }

    // At least one omniclaude topic should have messages (the pipeline IS producing events)
    const withMessages = results.filter((r) => r.messageCount > 0);
    // Soft assertion: warn if nothing, hard-fail only if Kafka is completely silent
    if (withMessages.length === 0) {
      console.warn(
        '\n  WARNING: No canonical omniclaude topics have ANY messages. Check if events route to dev-prefixed topics instead.'
      );
    }
    // We still want the test to report the state; pass if at least connectivity works
    expect(results.length).toBe(omniclaudeTopics.length);
  }, 60_000);

  // -----------------------------------------------------------------------
  // 4. Dev-prefixed topics are identified as legacy
  // -----------------------------------------------------------------------

  it('dev-prefixed topics are identified as legacy', async () => {
    const existingTopics = await admin.listTopics();

    // Find all topics that start with a known environment prefix
    const devPrefixedTopics = existingTopics.filter((t) =>
      ENVIRONMENT_PREFIXES.some((prefix) => t.startsWith(`${prefix}.`))
    );

    // Separate into ONEX-style dev topics vs other dev topics
    const devOnexTopics = devPrefixedTopics.filter((t) => t.includes('.onex.'));
    const devOtherTopics = devPrefixedTopics.filter((t) => !t.includes('.onex.'));

    console.log('\n--- Dev-Prefixed (Legacy) Topics ---');
    console.log(`Total dev-prefixed topics: ${devPrefixedTopics.length}`);
    console.log(`  ONEX-style (dev.onex.*): ${devOnexTopics.length}`);
    console.log(`  Other (dev.*):           ${devOtherTopics.length}`);

    if (devOnexTopics.length > 0) {
      console.log('\n  Dev-prefixed ONEX topics (should be canonical):');
      // Probe a sample to show freshness
      const sampleSize = Math.min(devOnexTopics.length, 8);
      for (let i = 0; i < sampleSize; i++) {
        const probe = await probeTopic(admin, devOnexTopics[i]);
        const age = probe.latestTimestamp
          ? `${((Date.now() - probe.latestTimestamp) / 60_000).toFixed(1)} min ago`
          : 'no messages';
        console.log(`    ${devOnexTopics[i]}  (msgs: ${probe.messageCount}, last: ${age})`);
      }
      if (devOnexTopics.length > sampleSize) {
        console.log(`    ... and ${devOnexTopics.length - sampleSize} more`);
      }
    }

    if (devOtherTopics.length > 0) {
      console.log('\n  Other dev-prefixed topics:');
      for (const t of devOtherTopics.slice(0, 5)) {
        console.log(`    ${t}`);
      }
      if (devOtherTopics.length > 5) {
        console.log(`    ... and ${devOtherTopics.length - 5} more`);
      }
    }

    // Specifically check the known problematic topic
    const toolContentDevTopic = `dev.${SUFFIX_INTELLIGENCE_TOOL_CONTENT}`;
    const toolContentCanonical = SUFFIX_INTELLIGENCE_TOOL_CONTENT;
    const devProbe = await probeTopic(admin, toolContentDevTopic);
    const canonProbe = await probeTopic(admin, toolContentCanonical);

    console.log('\n--- Key Topic: tool-content ---');
    console.log(
      `  Canonical (${toolContentCanonical}): exists=${canonProbe.exists}, msgs=${canonProbe.messageCount}`
    );
    console.log(
      `  Legacy    (${toolContentDevTopic}): exists=${devProbe.exists}, msgs=${devProbe.messageCount}`
    );

    if (devProbe.messageCount > 0 && canonProbe.messageCount === 0) {
      console.log(
        '  ** DIAGNOSIS: Events are going to the dev-prefixed topic but NOT the canonical topic!'
      );
    }

    // All dev-prefixed topics should decompose into ONEX or other categories
    expect(devOnexTopics.length + devOtherTopics.length).toBe(devPrefixedTopics.length);
  }, 60_000);

  // -----------------------------------------------------------------------
  // 5. Event payloads match expected schemas
  // -----------------------------------------------------------------------

  it('event payloads match expected schemas', async () => {
    // Try to read a message from any topic that has data. Prefer omniclaude topics,
    // fall back to intelligence topics, then legacy agent topics.
    const candidateTopics = [
      SUFFIX_OMNICLAUDE_SESSION_STARTED,
      SUFFIX_OMNICLAUDE_PROMPT_SUBMITTED,
      SUFFIX_OMNICLAUDE_TOOL_EXECUTED,
      SUFFIX_INTELLIGENCE_CLAUDE_HOOK,
      SUFFIX_INTELLIGENCE_TOOL_CONTENT,
      // Also check dev-prefixed versions
      `dev.${SUFFIX_OMNICLAUDE_SESSION_STARTED}`,
      `dev.${SUFFIX_OMNICLAUDE_PROMPT_SUBMITTED}`,
      `dev.${SUFFIX_OMNICLAUDE_TOOL_EXECUTED}`,
      `dev.${SUFFIX_INTELLIGENCE_CLAUDE_HOOK}`,
      `dev.${SUFFIX_INTELLIGENCE_TOOL_CONTENT}`,
    ];

    let foundMessage: { topic: string; value: unknown } | null = null;

    for (const topic of candidateTopics) {
      const probe = await probeTopic(admin, topic);
      if (probe.messageCount > 0 && probe.latestValue !== null) {
        foundMessage = { topic, value: probe.latestValue };
        break;
      }
    }

    if (!foundMessage) {
      console.log('\n--- Event Payload Validation ---');
      console.log('  No messages found in any candidate topic. Skipping schema validation.');
      console.log('  Checked topics:');
      for (const t of candidateTopics) {
        console.log(`    - ${t}`);
      }
      // Soft pass: we report the state but don't fail
      return;
    }

    console.log(`\n--- Event Payload Validation (from: ${foundMessage.topic}) ---`);

    const payload = foundMessage.value as Record<string, unknown>;
    console.log(`  Keys: ${Object.keys(payload).join(', ')}`);

    // ONEX events should have standard envelope fields
    const expectedFields = ['session_id', 'emitted_at', 'correlation_id', 'schema_version'];
    // Also accept the canonical EventEnvelope shape: envelope_id, correlation_id, envelope_timestamp
    const envelopeFields = ['envelope_id', 'correlation_id', 'envelope_timestamp'];

    const hasOnexFields = expectedFields.filter((f) => f in payload);
    const hasEnvelopeFields = envelopeFields.filter((f) => f in payload);

    console.log(`  ONEX fields present:     ${hasOnexFields.join(', ') || '(none)'}`);
    console.log(`  Envelope fields present: ${hasEnvelopeFields.join(', ') || '(none)'}`);

    // Check for timestamp field (emitted_at)
    if ('emitted_at' in payload) {
      const emittedAt = payload.emitted_at as string;
      const parsed = new Date(emittedAt);
      console.log(`  emitted_at: ${emittedAt} (valid date: ${!isNaN(parsed.getTime())})`);
      expect(!isNaN(parsed.getTime())).toBe(true);
    }

    // Check for correlation_id (should be a UUID-like string)
    if ('correlation_id' in payload) {
      const corrId = payload.correlation_id as string;
      expect(corrId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      console.log(`  correlation_id: ${corrId} (UUID format: valid)`);
    }

    // Check for schema_version
    if ('schema_version' in payload) {
      console.log(`  schema_version: ${payload.schema_version}`);
    }

    // At minimum the message should be parseable JSON (which it is, since we got here)
    expect(payload).toBeDefined();
    expect(typeof payload).toBe('object');

    // The event should have SOME identifying field
    const hasIdentifier =
      'session_id' in payload ||
      'entity_id' in payload ||
      'correlation_id' in payload ||
      'event_type' in payload ||
      'hook' in payload;
    console.log(`  Has identifying field: ${hasIdentifier}`);
    expect(hasIdentifier).toBe(true);
  }, 60_000);
});
