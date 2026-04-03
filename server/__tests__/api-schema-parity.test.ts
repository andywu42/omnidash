/**
 * API-to-Client Zod Schema Parity Tests
 *
 * Validates that server transform output shapes pass client-side Zod
 * validation. This catches the class of bug fixed in OMN-5178 where
 * transforms returned raw Date objects but the Zod schema expected
 * ISO strings.
 *
 * OMN-5180
 */
import { describe, it, expect } from 'vitest';
import {
  patlearnArtifactSchema,
  patlearnSummarySchema,
} from '../../client/src/lib/schemas/api-response-schemas';

describe('API → Client Zod Schema Parity', () => {
  describe('patlearnArtifactSchema', () => {
    const validArtifact = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      patternId: '660e8400-e29b-41d4-a716-446655440001',
      patternName: 'test-pattern',
      patternType: 'behavioral',
      language: 'typescript',
      lifecycleState: 'candidate' as const,
      stateChangedAt: new Date().toISOString(),
      compositeScore: 0.85,
      scoringEvidence: { labelAgreement: { score: 0.9 } },
      signature: { hash: 'abc123', version: '1.0' },
      metrics: {},
      metadata: { description: 'Test pattern' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    it('transform output with ISO string dates passes validation', () => {
      const result = patlearnArtifactSchema.safeParse(validArtifact);
      expect(result.success).toBe(true);
    });

    it('accepts artifact with nullable language field', () => {
      const result = patlearnArtifactSchema.safeParse({
        ...validArtifact,
        language: null,
      });
      expect(result.success).toBe(true);
    });

    it('accepts artifact with omitted optional fields', () => {
      const {
        stateChangedAt: _stateChangedAt,
        updatedAt: _updatedAt,
        metadata: _metadata,
        ...minimal
      } = validArtifact;
      const result = patlearnArtifactSchema.safeParse(minimal);
      expect(result.success).toBe(true);
    });

    it('accepts artifact with null stateChangedAt and updatedAt (regression guard for OMN-5177)', () => {
      const result = patlearnArtifactSchema.safeParse({
        ...validArtifact,
        stateChangedAt: null,
        updatedAt: null,
      });
      expect(result.success).toBe(true);
    });

    it('accepts artifact matching real API shape (requested state, empty evidence)', () => {
      const realApiShape = {
        id: 'c953173a-1c89-47e1-a8b8-6b691b4eb304',
        patternId: '1afb071b-8142-4570-b5bb-a8d1fc4726f2',
        patternName: 'learning_requested',
        patternType: 'pipeline_request',
        language: null,
        lifecycleState: 'requested' as const,
        stateChangedAt: null,
        compositeScore: 0,
        scoringEvidence: {},
        signature: { trigger: 'session_stop', session_id: 'abc123' },
        metrics: {},
        metadata: { source: 'PatternLearningRequested' },
        createdAt: '2026-03-16T23:23:03.327Z',
        updatedAt: '2026-03-16T23:23:03.327Z',
      };
      const result = patlearnArtifactSchema.safeParse(realApiShape);
      expect(result.success).toBe(true);
    });

    it('raw Date objects fail validation (regression guard for OMN-5178)', () => {
      const withDates = {
        ...validArtifact,
        createdAt: new Date(), // Raw Date — must fail z.string()
        updatedAt: new Date(), // Raw Date — must fail z.string()
      };
      const result = patlearnArtifactSchema.safeParse(withDates);
      expect(result.success).toBe(false);
    });
  });

  describe('patlearnSummarySchema', () => {
    const validSummary = {
      totalPatterns: 42,
      byState: {
        requested: 5,
        candidate: 12,
        provisional: 10,
        validated: 13,
        deprecated: 2,
      },
      avgScores: {
        labelAgreement: 0.82,
        clusterCohesion: 0.75,
        frequencyFactor: 0.9,
        composite: 0.81,
      },
      window: '7d',
      promotionsInWindow: 3,
      deprecationsInWindow: 1,
    };

    it('transform output passes validation', () => {
      const result = patlearnSummarySchema.safeParse(validSummary);
      expect(result.success).toBe(true);
    });

    it('rejects negative count values', () => {
      const result = patlearnSummarySchema.safeParse({
        ...validSummary,
        totalPatterns: -1,
      });
      expect(result.success).toBe(false);
    });

    it('rejects scores outside 0-1 range', () => {
      const result = patlearnSummarySchema.safeParse({
        ...validSummary,
        avgScores: {
          ...validSummary.avgScores,
          composite: 1.5,
        },
      });
      expect(result.success).toBe(false);
    });
  });
});
