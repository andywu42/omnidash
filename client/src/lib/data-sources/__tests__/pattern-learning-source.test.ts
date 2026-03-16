import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  createMockResponse,
  setupFetchMock,
  resetFetchMock,
} from '../../../tests/utils/mock-fetch';
import {
  patlearnSource,
  PatlearnFetchError,
  type PatlearnArtifact,
  type PatlearnSummary,
  type PatlearnDetailResponse,
} from '../pattern-learning-source';

// ===========================
// Test Fixtures
// ===========================

const createValidArtifact = (overrides: Partial<PatlearnArtifact> = {}): PatlearnArtifact => ({
  id: 'artifact-001',
  patternId: 'pattern-001',
  patternName: 'Error Handling Pattern',
  patternType: 'error-handling',
  language: 'typescript',
  lifecycleState: 'validated',
  stateChangedAt: '2026-01-15T10:00:00Z',
  compositeScore: 0.85,
  scoringEvidence: {
    labelAgreement: {
      score: 0.9,
      matchedLabels: ['error', 'try-catch', 'async'],
      totalLabels: 4,
      disagreements: ['optional-chaining'],
    },
    clusterCohesion: {
      score: 0.82,
      clusterId: 'cluster-001',
      memberCount: 15,
      avgPairwiseSimilarity: 0.78,
      medoidId: 'pattern-003',
    },
    frequencyFactor: {
      score: 0.88,
      observedCount: 42,
      minRequired: 10,
      windowDays: 30,
    },
  },
  signature: {
    hash: 'sha256:abc123def456',
    version: '1.0.0',
    algorithm: 'sha256',
    inputs: ['ast', 'tokens', 'labels'],
    normalizations: ['whitespace', 'comments'],
  },
  metrics: {
    processingTimeMs: 125,
    inputCount: 50,
    clusterCount: 5,
    dedupMergeCount: 3,
    scoreHistory: [
      { score: 0.75, timestamp: '2026-01-01T00:00:00Z' },
      { score: 0.85, timestamp: '2026-01-15T00:00:00Z' },
    ],
  },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-15T10:00:00Z',
  ...overrides,
});

const createValidSummary = (overrides: Partial<PatlearnSummary> = {}): PatlearnSummary => ({
  totalPatterns: 150,
  byState: {
    requested: 0,
    candidate: 45,
    provisional: 30,
    validated: 60,
    deprecated: 15,
  },
  avgScores: {
    labelAgreement: 0.82,
    clusterCohesion: 0.75,
    frequencyFactor: 0.88,
    composite: 0.81,
  },
  window: '24h',
  promotionsInWindow: 5,
  deprecationsInWindow: 2,
  ...overrides,
});

// ===========================
// PatlearnFetchError Tests
// ===========================

describe('PatlearnFetchError', () => {
  it('creates error with status code', () => {
    const error = new PatlearnFetchError('patterns', 404);

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(PatlearnFetchError);
    expect(error.name).toBe('PatlearnFetchError');
    expect(error.method).toBe('patterns');
    expect(error.statusCode).toBe(404);
    expect(error.message).toBe('Failed to fetch PATLEARN patterns: HTTP 404');
  });

  it('creates error without status code (network error)', () => {
    const cause = new Error('Connection refused');
    const error = new PatlearnFetchError('summary', undefined, cause);

    expect(error.name).toBe('PatlearnFetchError');
    expect(error.method).toBe('summary');
    expect(error.statusCode).toBeUndefined();
    expect(error.cause).toBe(cause);
    expect(error.message).toBe('Failed to fetch PATLEARN summary: Connection refused');
  });

  it('creates error with non-Error cause', () => {
    const error = new PatlearnFetchError('detail', undefined, 'some string error');

    expect(error.message).toBe('Failed to fetch PATLEARN detail: Network error');
  });

  it('preserves method and status in error instance', () => {
    const error = new PatlearnFetchError('candidates', 500);

    expect(error.method).toBe('candidates');
    expect(error.statusCode).toBe(500);
  });
});

// ===========================
// PatternLearningSource Tests
// ===========================

describe('PatternLearningSource', () => {
  beforeEach(() => {
    resetFetchMock();
    vi.clearAllMocks();
    // Suppress console.warn for validation warnings in tests
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===========================
  // list() method tests
  // ===========================

  describe('list()', () => {
    it('calls correct URL without params', async () => {
      const mockArtifacts = [createValidArtifact()];
      setupFetchMock(
        new Map([['/api/intelligence/patterns/patlearn', createMockResponse(mockArtifacts)]])
      );

      const result = await patlearnSource.list();

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('artifact-001');
      expect(global.fetch).toHaveBeenCalledWith('/api/intelligence/patterns/patlearn');
    });

    it('handles single state param', async () => {
      const mockArtifacts = [createValidArtifact({ lifecycleState: 'validated' })];
      setupFetchMock(
        new Map([['/api/intelligence/patterns/patlearn', createMockResponse(mockArtifacts)]])
      );

      await patlearnSource.list({ state: 'validated' });

      expect(global.fetch).toHaveBeenCalledWith(
        '/api/intelligence/patterns/patlearn?state=validated'
      );
    });

    it('handles array of states param', async () => {
      const mockArtifacts = [createValidArtifact()];
      setupFetchMock(
        new Map([['/api/intelligence/patterns/patlearn', createMockResponse(mockArtifacts)]])
      );

      await patlearnSource.list({ state: ['candidate', 'provisional'] });

      expect(global.fetch).toHaveBeenCalledWith(
        '/api/intelligence/patterns/patlearn?state=candidate%2Cprovisional'
      );
    });

    it('handles all query params', async () => {
      const mockArtifacts = [createValidArtifact()];
      setupFetchMock(
        new Map([['/api/intelligence/patterns/patlearn', createMockResponse(mockArtifacts)]])
      );

      await patlearnSource.list({
        state: 'validated',
        limit: 20,
        offset: 10,
        sort: 'score',
        order: 'desc',
      });

      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('state=validated'));
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('limit=20'));
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('offset=10'));
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('sort=score'));
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('order=desc'));
    });

    it('throws PatlearnFetchError on HTTP error when fallback disabled', async () => {
      setupFetchMock(
        new Map([
          [
            '/api/intelligence/patterns/patlearn',
            createMockResponse(null, { status: 500, statusText: 'Internal Server Error' }),
          ],
        ])
      );

      await expect(patlearnSource.list({}, { fallbackToMock: false })).rejects.toThrow(
        PatlearnFetchError
      );
      await expect(patlearnSource.list({}, { fallbackToMock: false })).rejects.toThrow(
        'Failed to fetch PATLEARN patterns: HTTP 500'
      );
    });

    it('throws PatlearnFetchError on network error when fallback disabled', async () => {
      setupFetchMock(
        new Map([['/api/intelligence/patterns/patlearn', new Error('Network failure')]])
      );

      await expect(patlearnSource.list({}, { fallbackToMock: false })).rejects.toThrow(
        PatlearnFetchError
      );
      await expect(patlearnSource.list({}, { fallbackToMock: false })).rejects.toThrow(
        'Network failure'
      );
    });

    it('returns empty array for non-array response (tests safeParseArray)', async () => {
      setupFetchMock(
        new Map([['/api/intelligence/patterns/patlearn', createMockResponse({ notAnArray: true })]])
      );

      const result = await patlearnSource.list();

      expect(result).toEqual([]);
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('[patlearn-list] Expected array')
      );
    });

    it('filters out invalid items from array (tests safeParseArray)', async () => {
      const validArtifact = createValidArtifact();
      const invalidArtifact = { id: 'incomplete' }; // Missing required fields
      setupFetchMock(
        new Map([
          [
            '/api/intelligence/patterns/patlearn',
            createMockResponse([validArtifact, invalidArtifact, validArtifact]),
          ],
        ])
      );

      const result = await patlearnSource.list();

      expect(result).toHaveLength(2);
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('[patlearn-list] Item 1 failed validation')
      );
    });
  });

  // ===========================
  // summary() method tests
  // ===========================

  describe('summary()', () => {
    it('calls correct URL with default window param', async () => {
      const mockSummary = createValidSummary();
      setupFetchMock(
        new Map([['/api/intelligence/patterns/patlearn/summary', createMockResponse(mockSummary)]])
      );

      const result = await patlearnSource.summary();

      expect(result).not.toBeNull();
      expect(result?.totalPatterns).toBe(150);
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/intelligence/patterns/patlearn/summary?window=24h'
      );
    });

    it('calls correct URL with custom window param', async () => {
      const mockSummary = createValidSummary({ window: '7d' });
      setupFetchMock(
        new Map([['/api/intelligence/patterns/patlearn/summary', createMockResponse(mockSummary)]])
      );

      await patlearnSource.summary('7d');

      expect(global.fetch).toHaveBeenCalledWith(
        '/api/intelligence/patterns/patlearn/summary?window=7d'
      );
    });

    it('returns parsed summary with all fields', async () => {
      const mockSummary = createValidSummary();
      setupFetchMock(
        new Map([['/api/intelligence/patterns/patlearn/summary', createMockResponse(mockSummary)]])
      );

      const result = await patlearnSource.summary();

      expect(result).toEqual(mockSummary);
      expect(result?.byState.validated).toBe(60);
      expect(result?.avgScores.composite).toBe(0.81);
    });

    it('throws PatlearnFetchError on HTTP error when fallback disabled', async () => {
      setupFetchMock(
        new Map([
          [
            '/api/intelligence/patterns/patlearn/summary',
            createMockResponse(null, { status: 403, statusText: 'Forbidden' }),
          ],
        ])
      );

      await expect(patlearnSource.summary('24h', { fallbackToMock: false })).rejects.toThrow(
        PatlearnFetchError
      );
      await expect(patlearnSource.summary('24h', { fallbackToMock: false })).rejects.toThrow(
        'HTTP 403'
      );
    });

    it('falls back to mock data on HTTP error when fallbackToMock is true', async () => {
      setupFetchMock(
        new Map([
          [
            '/api/intelligence/patterns/patlearn/summary',
            createMockResponse(null, { status: 500, statusText: 'Internal Server Error' }),
          ],
        ])
      );

      const result = await patlearnSource.summary('24h', { fallbackToMock: true });

      // Should return mock summary data instead of throwing
      expect(result).toBeDefined();
      expect(result?.totalPatterns).toBeGreaterThan(0);
      expect(result?.byState).toBeDefined();
    });

    it('returns null for invalid data (tests safeParseOne)', async () => {
      setupFetchMock(
        new Map([
          ['/api/intelligence/patterns/patlearn/summary', createMockResponse({ invalid: 'data' })],
        ])
      );

      const result = await patlearnSource.summary();

      expect(result).toBeNull();
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('[patlearn-summary] Validation failed')
      );
    });
  });

  // ===========================
  // detail() method tests
  // ===========================

  describe('detail()', () => {
    it('returns null for 404 response', async () => {
      setupFetchMock(
        new Map([
          [
            '/api/intelligence/patterns/patlearn/not-found-id',
            createMockResponse(null, { status: 404, statusText: 'Not Found' }),
          ],
        ])
      );

      const result = await patlearnSource.detail('not-found-id');

      expect(result).toBeNull();
    });

    it('throws PatlearnFetchError for non-404 HTTP errors', async () => {
      setupFetchMock(
        new Map([
          [
            '/api/intelligence/patterns/patlearn/error-id',
            createMockResponse(null, { status: 500, statusText: 'Internal Server Error' }),
          ],
        ])
      );

      await expect(patlearnSource.detail('error-id')).rejects.toThrow(PatlearnFetchError);
      await expect(patlearnSource.detail('error-id')).rejects.toThrow('HTTP 500');
    });

    it('returns artifact and similarPatterns for valid response', async () => {
      const artifact = createValidArtifact({ id: 'detail-001' });
      const mockResponse: PatlearnDetailResponse = {
        artifact,
        similarPatterns: [
          {
            patternId: 'similar-001',
            evidence: {
              keyword: { score: 0.8, intersection: ['error', 'catch'], unionCount: 5 },
              pattern: { score: 0.75, matchedIndicators: ['try-catch'], totalIndicators: 3 },
              structural: { score: 0.7, astDepthDelta: 1, nodeCountDelta: 5, complexityDelta: 0.2 },
              label: { score: 0.85, matchedLabels: ['error'], totalLabels: 2 },
              context: { score: 0.6, sharedTokens: ['async'], jaccard: 0.5 },
              composite: 0.74,
              weights: { keyword: 0.3, pattern: 0.25, structural: 0.2, label: 0.15, context: 0.1 },
            },
          },
        ],
      };
      setupFetchMock(
        new Map([
          ['/api/intelligence/patterns/patlearn/detail-001', createMockResponse(mockResponse)],
        ])
      );

      const result = await patlearnSource.detail('detail-001');

      expect(result).not.toBeNull();
      expect(result?.artifact.id).toBe('detail-001');
      expect(result?.similarPatterns).toHaveLength(1);
      expect(result?.similarPatterns[0].patternId).toBe('similar-001');
    });

    it('returns empty similarPatterns array when not provided', async () => {
      const artifact = createValidArtifact();
      setupFetchMock(
        new Map([['/api/intelligence/patterns/patlearn/', createMockResponse({ artifact })]])
      );

      const result = await patlearnSource.detail('artifact-001');

      expect(result).not.toBeNull();
      expect(result?.similarPatterns).toEqual([]);
    });

    it('filters out malformed similarPatterns entries', async () => {
      const artifact = createValidArtifact({ id: 'filter-test' });
      const validSimilarPattern = {
        patternId: 'valid-001',
        evidence: {
          keyword: { score: 0.8, intersection: ['error'], unionCount: 3 },
          pattern: { score: 0.7, matchedIndicators: ['try-catch'], totalIndicators: 2 },
          structural: { score: 0.6, astDepthDelta: 1, nodeCountDelta: 2, complexityDelta: 0.1 },
          label: { score: 0.9, matchedLabels: ['error'], totalLabels: 1 },
          context: { score: 0.5, sharedTokens: ['async'], jaccard: 0.4 },
          composite: 0.7,
          weights: { keyword: 0.3, pattern: 0.25, structural: 0.2, label: 0.15, context: 0.1 },
        },
      };
      const malformedSimilarPattern = {
        patternId: 'malformed-001',
        evidence: { invalid: 'structure' }, // Missing required fields
      };
      const nullEntry = null;
      const mockResponse = {
        artifact,
        similarPatterns: [
          validSimilarPattern,
          malformedSimilarPattern,
          nullEntry,
          validSimilarPattern,
        ],
      };
      setupFetchMock(
        new Map([
          ['/api/intelligence/patterns/patlearn/filter-test', createMockResponse(mockResponse)],
        ])
      );

      const result = await patlearnSource.detail('filter-test');

      expect(result).not.toBeNull();
      // Only valid entries should pass through (2 valid ones)
      expect(result?.similarPatterns).toHaveLength(2);
      expect(result?.similarPatterns[0].patternId).toBe('valid-001');
      expect(result?.similarPatterns[1].patternId).toBe('valid-001');
      // Verify validation warnings were logged
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('[patlearn-detail-similar]')
      );
    });

    it('throws PatlearnFetchError for invalid artifact data', async () => {
      setupFetchMock(
        new Map([
          [
            '/api/intelligence/patterns/patlearn/invalid',
            createMockResponse({ artifact: { invalid: 'data' }, similarPatterns: [] }),
          ],
        ])
      );

      await expect(patlearnSource.detail('invalid')).rejects.toThrow(PatlearnFetchError);
      await expect(patlearnSource.detail('invalid')).rejects.toThrow('Invalid artifact data');
    });

    it('throws PatlearnFetchError on network error', async () => {
      setupFetchMock(
        new Map([['/api/intelligence/patterns/patlearn/network-error', new Error('Timeout')]])
      );

      await expect(patlearnSource.detail('network-error')).rejects.toThrow(PatlearnFetchError);
    });
  });

  // ===========================
  // Convenience Methods Tests
  // ===========================

  describe('candidates()', () => {
    it('calls list with candidate and provisional states', async () => {
      const mockArtifacts = [
        createValidArtifact({ lifecycleState: 'candidate' }),
        createValidArtifact({ lifecycleState: 'provisional' }),
      ];
      setupFetchMock(
        new Map([['/api/intelligence/patterns/patlearn', createMockResponse(mockArtifacts)]])
      );

      const result = await patlearnSource.candidates();

      expect(result).toHaveLength(2);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('state=candidate%2Cprovisional')
      );
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('sort=score'));
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('order=desc'));
    });

    it('uses custom limit parameter', async () => {
      setupFetchMock(new Map([['/api/intelligence/patterns/patlearn', createMockResponse([])]]));

      await patlearnSource.candidates(25);

      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('limit=25'));
    });

    it('uses default limit of 50', async () => {
      setupFetchMock(new Map([['/api/intelligence/patterns/patlearn', createMockResponse([])]]));

      await patlearnSource.candidates();

      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('limit=50'));
    });
  });

  describe('validated()', () => {
    it('calls list with validated state', async () => {
      const mockArtifacts = [createValidArtifact({ lifecycleState: 'validated' })];
      setupFetchMock(
        new Map([['/api/intelligence/patterns/patlearn', createMockResponse(mockArtifacts)]])
      );

      const result = await patlearnSource.validated();

      expect(result).toHaveLength(1);
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('state=validated'));
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('sort=score'));
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('order=desc'));
    });

    it('uses custom limit parameter', async () => {
      setupFetchMock(new Map([['/api/intelligence/patterns/patlearn', createMockResponse([])]]));

      await patlearnSource.validated(100);

      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('limit=100'));
    });
  });

  describe('deprecated()', () => {
    it('calls list with deprecated state and updated sort', async () => {
      const mockArtifacts = [createValidArtifact({ lifecycleState: 'deprecated' })];
      setupFetchMock(
        new Map([['/api/intelligence/patterns/patlearn', createMockResponse(mockArtifacts)]])
      );

      const result = await patlearnSource.deprecated();

      expect(result).toHaveLength(1);
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('state=deprecated'));
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('sort=updated'));
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('order=desc'));
    });

    it('uses custom limit parameter', async () => {
      setupFetchMock(new Map([['/api/intelligence/patterns/patlearn', createMockResponse([])]]));

      await patlearnSource.deprecated(10);

      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('limit=10'));
    });
  });

  describe('topPatterns()', () => {
    it('calls list with score sort and no state filter', async () => {
      const mockArtifacts = [
        createValidArtifact({ compositeScore: 0.95 }),
        createValidArtifact({ compositeScore: 0.9 }),
      ];
      setupFetchMock(
        new Map([['/api/intelligence/patterns/patlearn', createMockResponse(mockArtifacts)]])
      );

      const result = await patlearnSource.topPatterns();

      expect(result).toHaveLength(2);
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('sort=score'));
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('order=desc'));
      // Should NOT contain state filter
      expect(global.fetch).not.toHaveBeenCalledWith(expect.stringContaining('state='));
    });

    it('uses default limit of 20', async () => {
      setupFetchMock(new Map([['/api/intelligence/patterns/patlearn', createMockResponse([])]]));

      await patlearnSource.topPatterns();

      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('limit=20'));
    });

    it('uses custom limit parameter', async () => {
      setupFetchMock(new Map([['/api/intelligence/patterns/patlearn', createMockResponse([])]]));

      await patlearnSource.topPatterns(5);

      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('limit=5'));
    });
  });

  // ===========================
  // Integration-style Tests
  // ===========================

  describe('error propagation', () => {
    it('preserves PatlearnFetchError when fallback disabled', async () => {
      setupFetchMock(
        new Map([
          [
            '/api/intelligence/patterns/patlearn',
            createMockResponse(null, { status: 401, statusText: 'Unauthorized' }),
          ],
        ])
      );

      // Test that error type is preserved when fallback is disabled
      try {
        await patlearnSource.list({}, { fallbackToMock: false });
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(PatlearnFetchError);
        expect((error as PatlearnFetchError).statusCode).toBe(401);
        expect((error as PatlearnFetchError).method).toBe('patterns');
      }
    });

    it('handles re-throwing original PatlearnFetchError when fallback disabled', async () => {
      setupFetchMock(
        new Map([
          [
            '/api/intelligence/patterns/patlearn',
            createMockResponse(null, { status: 429, statusText: 'Too Many Requests' }),
          ],
        ])
      );

      await expect(patlearnSource.list({}, { fallbackToMock: false })).rejects.toMatchObject({
        name: 'PatlearnFetchError',
        statusCode: 429,
        method: 'patterns',
      });
    });

    it('falls back to mock data when fallbackToMock is true on error', async () => {
      setupFetchMock(
        new Map([
          [
            '/api/intelligence/patterns/patlearn',
            createMockResponse(null, { status: 500, statusText: 'Internal Server Error' }),
          ],
        ])
      );

      // Opt-in to graceful degradation: returns mock data
      const result = await patlearnSource.list({}, { fallbackToMock: true });

      expect(result).toBeInstanceOf(Array);
      expect(result.length).toBeGreaterThan(0);
      // Mock data has __demo flag in metadata
      expect(result[0].metadata?.__demo).toBe(true);
    });
  });

  describe('data validation edge cases', () => {
    it('handles null response in array', async () => {
      const validArtifact = createValidArtifact();
      setupFetchMock(
        new Map([
          ['/api/intelligence/patterns/patlearn', createMockResponse([null, validArtifact, null])],
        ])
      );

      const result = await patlearnSource.list();

      // null items should be filtered out by safeParseArray
      expect(result).toHaveLength(1);
    });

    it('handles undefined fields in artifact', async () => {
      const artifact = createValidArtifact();
      // Remove optional fields
      delete artifact.stateChangedAt;
      delete artifact.updatedAt;
      delete artifact.language;
      artifact.scoringEvidence.labelAgreement.disagreements = undefined;

      setupFetchMock(
        new Map([['/api/intelligence/patterns/patlearn', createMockResponse([artifact])]])
      );

      const result = await patlearnSource.list();

      expect(result).toHaveLength(1);
      expect(result[0].stateChangedAt).toBeUndefined();
    });

    it('handles empty metrics scoreHistory', async () => {
      const artifact = createValidArtifact();
      artifact.metrics.scoreHistory = [];

      setupFetchMock(
        new Map([['/api/intelligence/patterns/patlearn', createMockResponse([artifact])]])
      );

      const result = await patlearnSource.list();

      expect(result).toHaveLength(1);
      expect(result[0].metrics.scoreHistory).toEqual([]);
    });
  });
});
