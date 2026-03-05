/**
 * Unit tests for extractActionFromTopic — the pattern-based parser that
 * replaces positional indexing for extracting action segments from ONEX
 * canonical topic names.
 *
 * Verifies that version suffixes (v1, v2) never leak as actionType.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { EventEmitter } from 'events';

// Mock heavy server-side dependencies to prevent esbuild TextEncoder invariant errors
// in the jsdom test environment. (Same mocks as websocket.test.ts)
vi.mock('../event-consumer', () => {
  const { EventEmitter } = require('events');
  return { eventConsumer: new EventEmitter() };
});

vi.mock('../event-bus-data-source', () => ({
  getEventBusDataSource: () => null,
}));

vi.mock('../playback-data-source', () => ({
  getPlaybackDataSource: () => new EventEmitter(),
}));

vi.mock('../playback-events', () => ({
  playbackEventEmitter: new EventEmitter(),
}));

vi.mock('../registry-events', () => ({
  registryEventEmitter: new EventEmitter(),
}));

vi.mock('../intent-events', () => ({
  intentEventEmitter: new EventEmitter(),
}));

vi.mock('../utils/case-transform', () => ({
  transformNodeIntrospectionToSnakeCase: (e: any) => e,
  transformNodeHeartbeatToSnakeCase: (e: any) => e,
  transformNodeStateChangeToSnakeCase: (e: any) => e,
  transformNodesToSnakeCase: (nodes: any) => nodes,
}));

vi.mock('../storage', () => ({
  getIntelligenceDb: () => null,
}));

describe('extractActionFromTopic', () => {
  // Lazy import to avoid esbuild invariant issues at module load time
  let extractActionFromTopic: typeof import('../websocket').extractActionFromTopic;

  beforeAll(async () => {
    const mod = await import('../websocket');
    extractActionFromTopic = mod.extractActionFromTopic;
  });

  // Standard 6-segment ONEX topics: {env}.onex.{kind}.{producer}.{action}.v{N}
  it('extracts action from standard 6-segment topic', () => {
    const parts = 'dev.onex.evt.platform.node-heartbeat.v1'.split('.');
    const result = extractActionFromTopic(parts);
    expect(result.actionType).toBe('node-heartbeat');
    expect(result.actionName).toBe('onex.evt.platform.node-heartbeat.v1');
  });

  it('extracts action from tool-content event', () => {
    const parts = 'dev.onex.evt.omniintelligence.tool-content.v1'.split('.');
    const result = extractActionFromTopic(parts);
    expect(result.actionType).toBe('tool-content');
    expect(result.actionName).toBe('onex.evt.omniintelligence.tool-content.v1');
  });

  // cmd kind
  it('extracts action from cmd topic', () => {
    const parts = 'onex.cmd.platform.request-introspection.v1'.split('.');
    const result = extractActionFromTopic(parts);
    expect(result.actionType).toBe('request-introspection');
    expect(result.actionName).toBe('onex.cmd.platform.request-introspection.v1');
  });

  // snapshot kind
  it('extracts action from snapshot topic', () => {
    const parts = 'dev.onex.snapshot.platform.registration-snapshots.v1'.split('.');
    const result = extractActionFromTopic(parts);
    expect(result.actionType).toBe('registration-snapshots');
    expect(result.actionName).toBe('onex.snapshot.platform.registration-snapshots.v1');
  });

  // 5-segment topic (no producer): {env}.onex.{kind}.{action}.v{N}
  it('handles 5-segment topic without producer', () => {
    const parts = 'dev.onex.evt.node-heartbeat.v1'.split('.');
    const result = extractActionFromTopic(parts);
    expect(result.actionType).toBe('node-heartbeat');
    // Must NOT be "v1"
    expect(result.actionType).not.toMatch(/^v\d+$/);
  });

  // Topic with no env prefix
  it('handles topic starting with onex', () => {
    const parts = 'onex.evt.platform.node-heartbeat.v1'.split('.');
    const result = extractActionFromTopic(parts);
    expect(result.actionType).toBe('node-heartbeat');
  });

  // Intent kind
  it('handles intent kind topics', () => {
    const parts = 'dev.onex.intent.classifier.intent-classified.v1'.split('.');
    const result = extractActionFromTopic(parts);
    expect(result.actionType).toBe('intent-classified');
  });

  // DLQ kind
  it('handles dlq kind topics', () => {
    const parts = 'dev.onex.dlq.platform.failed-event.v1'.split('.');
    const result = extractActionFromTopic(parts);
    expect(result.actionType).toBe('failed-event');
  });

  // Edge: missing version suffix
  it('handles topic without version suffix', () => {
    const parts = 'dev.onex.evt.platform.node-heartbeat'.split('.');
    const result = extractActionFromTopic(parts);
    expect(result.actionType).toBe('node-heartbeat');
  });

  // Edge: extra segments
  it('handles topic with extra segments', () => {
    const parts = 'dev.onex.evt.platform.sub-system.some-action.v2'.split('.');
    const result = extractActionFromTopic(parts);
    expect(result.actionType).toBe('some-action');
  });

  // Edge: no 'onex' token at all
  it('falls back gracefully for non-ONEX topics', () => {
    const parts = 'some-flat-topic-name'.split('.');
    const result = extractActionFromTopic(parts);
    expect(result.actionType).toBe('some-flat-topic-name');
  });

  // Edge: empty parts
  it('handles empty parts array', () => {
    const result = extractActionFromTopic([]);
    expect(result.actionType).toBe('unknown');
  });

  // v2 version suffix
  it('strips v2 version suffix correctly', () => {
    const parts = 'dev.onex.evt.platform.contract-registered.v2'.split('.');
    const result = extractActionFromTopic(parts);
    expect(result.actionType).toBe('contract-registered');
    expect(result.actionType).not.toMatch(/^v\d+$/);
  });
});
