/**
 * Pattern Learning Data Source
 *
 * Fetches PATLEARN artifacts from API endpoints.
 *
 * Part of OMN-1699: Pattern Dashboard with Evidence-Based Score Debugging
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
    .map((item: unknown, index: number) => {
      const result = schema.safeParse(item);
      if (!result.success) {
        console.warn(`[${context}] Item ${index} failed validation`);
        return null;
      }
      return result.data;
    })
    .filter((item: T | null | undefined): item is T => item !== null);
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
  private baseUrl = '/api/intelligence/patterns/patlearn';

  /**
   * List patterns with filtering
   */
  async list(params: PatlearnListParams = {}): Promise<PatlearnArtifact[]> {
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
      return safeParseArray(patlearnArtifactSchema, data, 'patlearn-list');
    } catch (error) {
      if (error instanceof PatlearnFetchError) {
        throw error;
      }
      throw new PatlearnFetchError('patterns', undefined, error);
    }
  }

  /**
   * Get summary metrics
   */
  async summary(window: '24h' | '7d' | '30d' = '24h'): Promise<PatlearnSummary | null> {
    try {
      const response = await fetch(`${this.baseUrl}/summary?window=${window}`);

      if (!response.ok) {
        throw new PatlearnFetchError('summary', response.status);
      }

      const data = await response.json();
      return safeParseOne(patlearnSummarySchema, data, 'patlearn-summary');
    } catch (error) {
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

  async candidates(limit = 50): Promise<PatlearnArtifact[]> {
    return this.list({
      state: ['candidate', 'provisional'],
      limit,
      sort: 'score',
      order: 'desc',
    });
  }

  async validated(limit = 50): Promise<PatlearnArtifact[]> {
    return this.list({
      state: 'validated',
      limit,
      sort: 'score',
      order: 'desc',
    });
  }

  async deprecated(limit = 50): Promise<PatlearnArtifact[]> {
    return this.list({
      state: 'deprecated',
      limit,
      sort: 'updated',
      order: 'desc',
    });
  }

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
