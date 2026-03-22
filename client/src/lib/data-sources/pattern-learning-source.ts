/**
 * Pattern Learning Data Source
 *
 * Fetches PATLEARN artifacts from API endpoints with graceful fallback
 * to mock data when the database is unavailable.
 *
 * Part of OMN-1699: Pattern Dashboard with Evidence-Based Score Debugging
 * Updated for OMN-1798: Graceful degradation support
 */

import {
  patlearnArtifactSchema,
  patlearnSummarySchema,
  similarPatternEntrySchema,
  type PatlearnArtifact,
  type PatlearnSummary,
  type LifecycleState,
  type SimilarPatternEntry,
} from '../schemas/api-response-schemas';
import { getMockPatterns, getMockSummary } from '../mock-data/patlearn-mock';

// ===========================
// Types
// ===========================

export interface PatlearnListParams {
  state?: LifecycleState | LifecycleState[];
  limit?: number;
  offset?: number;
  sort?: 'score' | 'created' | 'updated';
  order?: 'asc' | 'desc';
}

export interface PatlearnDetailResponse {
  artifact: PatlearnArtifact;
  similarPatterns: SimilarPatternEntry[];
}

/**
 * Options for data source methods
 */
export interface PatlearnFetchOptions {
  /**
   * If true, fallback to mock data on error instead of throwing.
   * Default: false (errors are thrown; set to true for demo/graceful degradation)
   */
  fallbackToMock?: boolean;
  /**
   * When true, skip the API call entirely and return canned demo data.
   * Used when global demo mode is active (OMN-2298).
   */
  demoMode?: boolean;
}

// ===========================
// Custom Error Class
// ===========================

export class PatlearnFetchError extends Error {
  constructor(
    public readonly method: string,
    public readonly statusCode?: number,
    public readonly cause?: unknown
  ) {
    const message = statusCode
      ? `Failed to fetch PATLEARN ${method}: HTTP ${statusCode}`
      : `Failed to fetch PATLEARN ${method}: ${cause instanceof Error ? cause.message : 'Network error'}`;
    super(message);
    this.name = 'PatlearnFetchError';
  }
}

// ===========================
// Helper Functions
// ===========================

function safeParseArray<T>(
  schema: { safeParse: (data: unknown) => { success: boolean; data?: T } },
  data: unknown,
  context: string
): T[] {
  if (!Array.isArray(data)) {
    console.warn(`[${context}] Expected array, got ${typeof data}`);
    return [];
  }

  return data
    .map((item, index) => {
      const result = schema.safeParse(item);
      if (!result.success) {
        console.warn(`[${context}] Item ${index} failed validation`);
        return null;
      }
      return result.data;
    })
    .filter((item): item is T => item !== null);
}

function safeParseOne<T>(
  schema: { safeParse: (data: unknown) => { success: boolean; data?: T } },
  data: unknown,
  context: string
): T | null {
  const result = schema.safeParse(data);
  if (!result.success) {
    console.warn(`[${context}] Validation failed`);
    return null;
  }
  // After success check, Zod guarantees data is defined
  return result.data!;
}

// ===========================
// Data Source Class
// ===========================

class PatternLearningSource {
  private baseUrl = '/api/patterns/patlearn';

  /** Track if we're currently using mock data (for UI indicator) */
  private _isUsingMockData = false;

  /** Check if last fetch used mock data */
  get isUsingMockData(): boolean {
    return this._isUsingMockData;
  }

  /**
   * List patterns with filtering
   * Falls back to mock data if database is unavailable (graceful degradation)
   */
  async list(
    params: PatlearnListParams = {},
    options: PatlearnFetchOptions = {}
  ): Promise<PatlearnArtifact[]> {
    const { fallbackToMock = false, demoMode = false } = options;
    if (demoMode) {
      this._isUsingMockData = true;
      let mockPatterns = getMockPatterns();
      if (params.state) {
        const states = Array.isArray(params.state) ? params.state : [params.state];
        mockPatterns = mockPatterns.filter((p) =>
          states.includes(p.lifecycleState as LifecycleState)
        );
      }
      const offset = params.offset ?? 0;
      const limit = params.limit ?? 50;
      return mockPatterns.slice(offset, offset + limit);
    }

    try {
      const query = new URLSearchParams();

      if (params.state) {
        const states = Array.isArray(params.state) ? params.state.join(',') : params.state;
        query.set('state', states);
      }
      if (params.limit !== undefined) query.set('limit', String(params.limit));
      if (params.offset !== undefined) query.set('offset', String(params.offset));
      if (params.sort) query.set('sort', params.sort);
      if (params.order) query.set('order', params.order);

      const url = query.toString() ? `${this.baseUrl}?${query}` : this.baseUrl;
      const response = await fetch(url);

      if (!response.ok) {
        throw new PatlearnFetchError('patterns', response.status);
      }

      const data = await response.json();
      const patterns = safeParseArray(patlearnArtifactSchema, data, 'patlearn-list');

      // Successfully fetched from API
      this._isUsingMockData = false;
      return patterns;
    } catch (error) {
      // Graceful degradation: fallback to mock data
      if (fallbackToMock) {
        console.warn(
          '[PatternLearningSource] Database unavailable, using demo data:',
          error instanceof Error ? error.message : 'Unknown error'
        );
        this._isUsingMockData = true;

        // Apply filtering to mock data
        let mockPatterns = getMockPatterns();

        // Filter by state if specified
        if (params.state) {
          const states = Array.isArray(params.state) ? params.state : [params.state];
          mockPatterns = mockPatterns.filter((p) =>
            states.includes(p.lifecycleState as LifecycleState)
          );
        }

        // Apply pagination
        const offset = params.offset ?? 0;
        const limit = params.limit ?? 50;
        mockPatterns = mockPatterns.slice(offset, offset + limit);

        return mockPatterns;
      }

      // Re-throw if fallback disabled
      if (error instanceof PatlearnFetchError) {
        throw error;
      }
      throw new PatlearnFetchError('patterns', undefined, error);
    }
  }

  /**
   * Get summary metrics
   * Falls back to mock data if database is unavailable (graceful degradation)
   */
  async summary(
    window: '24h' | '7d' | '30d' = '24h',
    options: PatlearnFetchOptions = {}
  ): Promise<PatlearnSummary | null> {
    const { fallbackToMock = false, demoMode = false } = options;
    if (demoMode) {
      this._isUsingMockData = true;
      return getMockSummary(window);
    }

    try {
      const response = await fetch(`${this.baseUrl}/summary?window=${window}`);

      if (!response.ok) {
        throw new PatlearnFetchError('summary', response.status);
      }

      const data = await response.json();
      const summary = safeParseOne(patlearnSummarySchema, data, 'patlearn-summary');

      // Successfully fetched from API
      this._isUsingMockData = false;
      return summary;
    } catch (error) {
      // Graceful degradation: fallback to mock data
      if (fallbackToMock) {
        console.warn(
          '[PatternLearningSource] Database unavailable for summary, using demo data:',
          error instanceof Error ? error.message : 'Unknown error'
        );
        this._isUsingMockData = true;
        return getMockSummary(window);
      }

      // Re-throw if fallback disabled
      if (error instanceof PatlearnFetchError) {
        throw error;
      }
      throw new PatlearnFetchError('summary', undefined, error);
    }
  }

  /**
   * Get full detail for a pattern (for ScoreDebugger)
   */
  async detail(id: string): Promise<PatlearnDetailResponse | null> {
    try {
      const response = await fetch(`${this.baseUrl}/${id}`);

      // Handle 404 as a valid "not found" state
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        throw new PatlearnFetchError('detail', response.status);
      }

      const data = await response.json();

      // Validate the artifact part
      const artifact = safeParseOne(patlearnArtifactSchema, data.artifact, 'patlearn-detail');
      if (!artifact) {
        throw new PatlearnFetchError('detail', undefined, new Error('Invalid artifact data'));
      }

      // Validate similarPatterns - filter out malformed entries
      const similarPatterns = safeParseArray(
        similarPatternEntrySchema,
        data.similarPatterns || [],
        'patlearn-detail-similar'
      );

      return {
        artifact,
        similarPatterns,
      };
    } catch (error) {
      if (error instanceof PatlearnFetchError) {
        throw error;
      }
      throw new PatlearnFetchError('detail', undefined, error);
    }
  }

  // ===========================
  // Derived Views (Convenience Methods)
  // ===========================

  /**
   * Get candidates (candidate + provisional states)
   */
  async candidates(limit = 50): Promise<PatlearnArtifact[]> {
    return this.list({
      state: ['candidate', 'provisional'],
      limit,
      sort: 'score',
      order: 'desc',
    });
  }

  /**
   * Get validated patterns (learned)
   */
  async validated(limit = 50): Promise<PatlearnArtifact[]> {
    return this.list({
      state: 'validated',
      limit,
      sort: 'score',
      order: 'desc',
    });
  }

  /**
   * Get deprecated patterns
   */
  async deprecated(limit = 50): Promise<PatlearnArtifact[]> {
    return this.list({
      state: 'deprecated',
      limit,
      sort: 'updated',
      order: 'desc',
    });
  }

  /**
   * Get all patterns sorted by score
   */
  async topPatterns(limit = 20): Promise<PatlearnArtifact[]> {
    return this.list({
      limit,
      sort: 'score',
      order: 'desc',
    });
  }
}

// ===========================
// Export Singleton
// ===========================

// Note: Named 'patlearnSource' to avoid collision with legacy patternLearningSource in archive
export const patlearnSource = new PatternLearningSource();

// Re-export types for convenience
export type {
  PatlearnArtifact,
  PatlearnSummary,
  LifecycleState,
  SimilarityEvidence,
  SimilarPatternEntry,
} from '../schemas/api-response-schemas';
