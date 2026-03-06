import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// Stub fetch once at module level, before static import of module under test.
// This stays active for the entire suite; afterAll cleans up.
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { fetchTopicNames } from '../event-bus-health-poller';

describe('fetchTopicNames', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
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
