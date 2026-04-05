#!/usr/bin/env npx tsx
/**
 * Golden Test Auto-Generator (OMN-7495)
 *
 * Generates a golden projection test skeleton for a new topic.
 *
 * Usage:
 *   npx tsx scripts/generate-golden-test.ts \
 *     --topic onex.evt.omniclaude.new-event.v1 \
 *     --table new_events \
 *     --handler projectNewEvent
 */

import { writeSync, openSync, closeSync, constants } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { values } = parseArgs({
  options: {
    topic: { type: 'string' },
    table: { type: 'string' },
    handler: { type: 'string' },
  },
});

if (!values.topic || !values.table || !values.handler) {
  console.error('Usage: --topic <topic> --table <table> --handler <handler>');
  process.exit(1);
}

const slug = values.topic
  .replace(/^onex\.(evt|cmd)\./, '')
  .replace(/\.v\d+$/, '')
  .replace(/\./g, '-');

const outPath = resolve(__dirname, `../server/__tests__/golden-chain/${slug}.golden.test.ts`);

// Atomic check-and-create: open with O_CREAT|O_EXCL to avoid TOCTOU race.
// Keep the fd open and write through it so no second open can race.
let fd: number;
try {
  fd = openSync(outPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
} catch (err: unknown) {
  if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
    console.error(`File already exists: ${outPath}`);
    process.exit(1);
  }
  throw err;
}

const template = `/**
 * Golden Projection Test: ${values.topic}
 * Table: ${values.table}
 * Handler: ${values.handler}
 *
 * AUTO-GENERATED -- fill in payload fields and assertions.
 * @ticket OMN-7495
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { makeKafkaPayload, goldenId } from './runner';

// Standard mock block
vi.mock('../../storage', () => ({
  tryGetIntelligenceDb: vi.fn(),
  getIntelligenceDb: vi.fn(),
  isDatabaseConfigured: vi.fn(() => false),
}));
vi.mock('kafkajs', () => ({
  Kafka: vi.fn(() => ({
    consumer: vi.fn(() => ({
      connect: vi.fn(), subscribe: vi.fn(), run: vi.fn(), disconnect: vi.fn(),
    })),
  })),
}));
vi.mock('../../projection-bootstrap', () => ({
  baselinesProjection: { reset: vi.fn() },
  llmRoutingProjection: { invalidateCache: vi.fn() },
}));
vi.mock('../../baselines-events', () => ({ emitBaselinesUpdate: vi.fn() }));
vi.mock('../../topic-catalog-manager', () => ({
  TopicCatalogManager: vi.fn(() => ({
    bootstrap: vi.fn(), stop: vi.fn().mockResolvedValue(undefined),
    once: vi.fn(), on: vi.fn(),
  })),
}));
vi.mock('../../llm-routing-events', () => ({ emitLlmRoutingInvalidate: vi.fn() }));
vi.mock('../../delegation-events', () => ({ emitDelegationInvalidate: vi.fn() }));
vi.mock('../../enrichment-events', () => ({ emitEnrichmentInvalidate: vi.fn() }));
vi.mock('../../enforcement-events', () => ({ emitEnforcementInvalidate: vi.fn() }));
vi.mock('../../omniclaude-state-events', () => ({
  emitGateDecisionInvalidate: vi.fn(),
  emitEpicRunInvalidate: vi.fn(),
  emitPrWatchInvalidate: vi.fn(),
  emitPipelineBudgetInvalidate: vi.fn(),
  emitCircuitBreakerInvalidate: vi.fn(),
}));
vi.mock('../../effectiveness-events', () => ({ emitEffectivenessUpdate: vi.fn() }));

import { ReadModelConsumer } from '../../read-model-consumer';

const TOPIC = '${values.topic}';
const TABLE = '${values.table}';

describe(\`Golden Chain: \${TOPIC} -> \${TABLE}\`, () => {
  let consumer: ReadModelConsumer;
  let handleMessage: (p: import('kafkajs').EachMessagePayload) => Promise<void>;

  beforeEach(() => {
    vi.clearAllMocks();
    consumer = new ReadModelConsumer();
    handleMessage = (
      consumer as unknown as { handleMessage: (p: import('kafkajs').EachMessagePayload) => Promise<void> }
    ).handleMessage.bind(consumer);
  });

  it('projects golden payload to ${values.table}', async () => {
    // TODO: Fill in exact payload fields and assertions for this pipeline
    const { tryGetIntelligenceDb } = await import('../../storage');
    const insertValues = vi.fn().mockResolvedValue(undefined);
    const insertMock = vi.fn().mockReturnValue({ values: insertValues });
    const executeMock = vi.fn().mockResolvedValue(undefined);
    (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue({
      insert: insertMock, execute: executeMock,
    });

    const payload = {
      // TODO: Fill in golden payload fields from handler source
      correlation_id: goldenId('${values.handler}'),
    };

    await handleMessage(makeKafkaPayload(TOPIC, payload));

    // TODO: Add field-level assertions
    expect(consumer.getStats().eventsProjected).toBe(1);
    expect(consumer.getStats().errorsCount).toBe(0);
  });

  it('handles missing DB gracefully', async () => {
    const { tryGetIntelligenceDb } = await import('../../storage');
    (tryGetIntelligenceDb as ReturnType<typeof vi.fn>).mockReturnValue(null);

    await handleMessage(makeKafkaPayload(TOPIC, {
      correlation_id: goldenId('${values.handler}-no-db'),
    }));

    expect(consumer.getStats().eventsProjected).toBe(0);
  });
});
`;

try {
  writeSync(fd, template);
} finally {
  closeSync(fd);
}
// eslint-disable-next-line no-console
console.log(`Generated: ${outPath}`);
