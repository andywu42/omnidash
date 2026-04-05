/**
 * GoldenEventTestRunner — shared infrastructure for golden projection tests.
 *
 * Provides:
 * - makeKafkaPayload(): builds minimal EachMessagePayload for testing handleMessage
 * - goldenId(): deterministic correlation IDs prefixed for cleanup
 * - getMode(): reads GOLDEN_MODE env var (unit | integration)
 *
 * @see docs/plans/2026-04-04-golden-event-tests.md
 * @ticket OMN-7495
 */

import { randomUUID } from 'crypto';
import type { EachMessagePayload } from 'kafkajs';

export type GoldenMode = 'unit' | 'integration';

export function getMode(): GoldenMode {
  return (process.env.GOLDEN_MODE || 'unit') as GoldenMode;
}

/**
 * Build a minimal EachMessagePayload for testing handleMessage.
 * Reuses the proven pattern from read-model-consumer.test.ts.
 */
export function makeKafkaPayload(
  topic: string,
  data: Record<string, unknown>,
  overrides: { partition?: number; offset?: string } = {}
): EachMessagePayload {
  return {
    topic,
    partition: overrides.partition ?? 0,
    message: {
      key: null,
      value: Buffer.from(JSON.stringify(data)),
      offset: overrides.offset ?? '0',
      timestamp: Date.now().toString(),
      attributes: 0,
      headers: {},
    },
    heartbeat: () => Promise.resolve(),
    pause: () => () => {},
  };
}

/**
 * Generate a deterministic correlation ID for golden tests.
 * Uses a prefix to make golden test data easy to identify and clean up.
 */
export function goldenId(suffix?: string): string {
  return suffix ? `golden-${suffix}-${randomUUID()}` : `golden-${randomUUID()}`;
}
