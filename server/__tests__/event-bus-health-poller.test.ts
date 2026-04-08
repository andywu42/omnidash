import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// Stub fetch once at module level, before static import of module under test.
// This stays active for the entire suite; afterAll cleans up.
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Set REDPANDA_ADMIN_URL before importing the module under test so that
// fetchTopicNames() calls succeed. The env var is cleaned up in afterAll.
const ORIGINAL_REDPANDA_ADMIN_URL = process.env.REDPANDA_ADMIN_URL;
process.env.REDPANDA_ADMIN_URL = 'http://test-redpanda:9644';

import { fetchTopicNames, EXPECTED_TOPICS } from '../event-bus-health-poller';

// Module-level cleanup: unstub globals after all describe blocks complete
// eslint-disable-next-line vitest/require-top-level-describe
afterAll(() => {
  vi.unstubAllGlobals();
  // Restore original env value
  if (ORIGINAL_REDPANDA_ADMIN_URL !== undefined) {
    process.env.REDPANDA_ADMIN_URL = ORIGINAL_REDPANDA_ADMIN_URL;
  } else {
    delete process.env.REDPANDA_ADMIN_URL;
  }
});

describe('fetchTopicNames', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('extracts unique topic names from /v1/partitions response, excluding redpanda namespace', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { ns: 'kafka', topic: 'topic-a', partition_id: 0 },
        { ns: 'kafka', topic: 'topic-a', partition_id: 1 },
        { ns: 'kafka', topic: 'topic-b', partition_id: 0 },
        { ns: 'redpanda', topic: '__consumer_offsets', partition_id: 0 },
      ],
    });

    const topics = await fetchTopicNames();
    expect(topics).toEqual(expect.arrayContaining(['topic-a', 'topic-b']));
    expect(topics).toHaveLength(2);
    // Only assert namespace filtering -- topics in ns='redpanda' are excluded
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/partitions'),
      expect.objectContaining({ signal: expect.any(Object) })
    );
  });

  it('returns empty array for empty partitions response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });

    const topics = await fetchTopicNames();
    expect(topics).toEqual([]);
  });

  it('returns empty array for non-array response (shape guard)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ error: 'unexpected shape' }),
    });

    const topics = await fetchTopicNames();
    expect(topics).toEqual([]);
  });

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
    await expect(fetchTopicNames()).rejects.toThrow('HTTP 404');
  });
});

/**
 * OMN-4970: Verify event-bus-health-poller configuration is compatible
 * with the Redpanda Admin API port 9644 exposure from OMN-4959.
 */
describe('event-bus-health-poller configuration (OMN-4970)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('uses REDPANDA_ADMIN_URL from env (OMN-7227: no localhost fallback)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });

    await fetchTopicNames();

    // Verify the URL from process.env.REDPANDA_ADMIN_URL is used
    expect(mockFetch).toHaveBeenCalledWith(
      'http://test-redpanda:9644/v1/partitions',
      expect.objectContaining({ signal: expect.any(Object) })
    );
  });

  it('throws when REDPANDA_ADMIN_URL is not set (OMN-7227)', async () => {
    const saved = process.env.REDPANDA_ADMIN_URL;
    delete process.env.REDPANDA_ADMIN_URL;
    try {
      await expect(fetchTopicNames()).rejects.toThrow('REDPANDA_ADMIN_URL is required');
    } finally {
      process.env.REDPANDA_ADMIN_URL = saved;
    }
  });

  it('EXPECTED_TOPICS includes core ONEX topic names for health monitoring', () => {
    // These topics are critical for the health dashboard to track.
    // If any are missing, the health poller will not report them as expected.
    const criticalTopics = [
      'onex.evt.omniclaude.gate-decision.v1',
      'onex.evt.omniclaude.epic-run-updated.v1',
      'onex.evt.omniclaude.pr-watch-updated.v1',
      'onex.evt.omniclaude.budget-cap-hit.v1',
      // OMN-7810: multi-producer topic (no service-specific segment)
      'onex.evt.pattern.discovered.v1',
      'onex.evt.omniintelligence.intent-classified.v1',
    ];

    for (const topic of criticalTopics) {
      expect(EXPECTED_TOPICS).toContain(topic);
    }
  });

  it('EXPECTED_TOPICS does not include legacy flat topic names', () => {
    // OMN-4083: legacy flat names like 'agent-actions' should not be in EXPECTED_TOPICS.
    // Only canonical ONEX-prefixed names should be used.
    const legacyTopics = [
      'agent-actions',
      'agent.routing.requested.v1',
      'agent.routing.completed.v1',
    ];
    for (const topic of legacyTopics) {
      expect(EXPECTED_TOPICS).not.toContain(topic);
    }
  });
});
