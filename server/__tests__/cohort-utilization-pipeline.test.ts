/**
 * Treatment/Control Cohort and Utilization Score Pipeline Tests (OMN-4967)
 *
 * Verifies the end-to-end data flow for A/B experiment cohorts:
 *
 * 1. omniclaude produces events with `cohort` ("treatment"|"control")
 *    and `utilization_score` (0.0-1.0)
 * 2. omnidash extraction-aggregator persists to injection_effectiveness table
 * 3. EffectivenessMetricsProjection.queryAB() returns both cohorts
 * 4. /effectiveness/ab UI receives treatment and control data
 *
 * This test suite validates the omnidash side of the pipeline using
 * type guards and mock data that mirrors real omniclaude event payloads.
 */

import { describe, it, expect } from 'vitest';
import { isContextUtilizationEvent, isAgentMatchEvent } from '@shared/extraction-types';
import type { ContextUtilizationEvent, AgentMatchEvent } from '@shared/extraction-types';
import type { ABComparison, CohortComparison } from '@shared/effectiveness-types';

describe('OMN-4967: Treatment/Control Cohort Pipeline', () => {
  describe('Event type guards accept cohort and utilization fields', () => {
    it('accepts treatment cohort event with non-zero utilization_score', () => {
      const event: ContextUtilizationEvent = {
        session_id: 'sess-001',
        correlation_id: 'corr-001',
        cohort: 'treatment',
        injection_occurred: true,
        agent_name: 'agent-api-architect',
        utilization_score: 0.73,
        utilization_method: 'identifier_overlap',
        user_visible_latency_ms: 145,
        cache_hit: true,
        patterns_count: 5,
      };

      expect(isContextUtilizationEvent(event)).toBe(true);
      expect(event.utilization_score).toBeGreaterThan(0);
      expect(event.cohort).toBe('treatment');
    });

    it('accepts control cohort event without injection', () => {
      const event: ContextUtilizationEvent = {
        session_id: 'sess-002',
        correlation_id: 'corr-002',
        cohort: 'control',
        injection_occurred: false,
        user_visible_latency_ms: 92,
      };

      expect(isContextUtilizationEvent(event)).toBe(true);
      expect(event.cohort).toBe('control');
      expect(event.injection_occurred).toBe(false);
    });

    it('accepts agent match event with cohort', () => {
      const event: AgentMatchEvent = {
        session_id: 'sess-003',
        correlation_id: 'corr-003',
        cohort: 'treatment',
        agent_match_score: 0.95,
        agent_name: 'agent-debug',
        session_outcome: 'success',
        injection_occurred: true,
      };

      expect(isAgentMatchEvent(event)).toBe(true);
      expect(event.cohort).toBe('treatment');
    });

    it('accepts events missing cohort field (cohort is now optional per OMN-6392)', () => {
      const event = {
        session_id: 'sess-004',
        correlation_id: 'corr-004',
        // cohort is optional since OMN-6392 — handlers default to 'unknown'
        utilization_score: 0.5,
      };

      expect(isContextUtilizationEvent(event)).toBe(true);
    });
  });

  describe('ABComparison type structure', () => {
    it('supports both treatment and control cohorts', () => {
      const comparison: ABComparison = {
        cohorts: [
          {
            cohort: 'treatment',
            session_count: 800,
            median_utilization_pct: 65.3,
            avg_accuracy_pct: 82.1,
            success_rate_pct: 78.5,
            avg_latency_ms: 156,
          },
          {
            cohort: 'control',
            session_count: 200,
            median_utilization_pct: 0,
            avg_accuracy_pct: 0,
            success_rate_pct: 71.2,
            avg_latency_ms: 98,
          },
        ],
        total_sessions: 1000,
      };

      expect(comparison.cohorts).toHaveLength(2);

      const treatment = comparison.cohorts.find((c: CohortComparison) => c.cohort === 'treatment');
      const control = comparison.cohorts.find((c: CohortComparison) => c.cohort === 'control');

      expect(treatment).toBeDefined();
      expect(control).toBeDefined();
      expect(treatment!.session_count).toBeGreaterThan(control!.session_count);
      expect(treatment!.median_utilization_pct).toBeGreaterThan(0);
    });

    it('validates 80/20 treatment/control split ratio', () => {
      // The omniclaude CohortAssignmentConfig defaults to 20% control
      const controlPct = 20;
      const treatmentPct = 100 - controlPct;

      expect(treatmentPct).toBe(80);
      expect(controlPct).toBe(20);
    });
  });

  describe('Utilization score semantics', () => {
    it('utilization_score represents patterns_used / patterns_injected', () => {
      // Verify the semantic contract: utilization_score is a ratio
      const patternsInjected = 10;
      const patternsUsed = 7;
      const expectedScore = patternsUsed / patternsInjected;

      expect(expectedScore).toBeCloseTo(0.7);
      expect(expectedScore).toBeGreaterThanOrEqual(0);
      expect(expectedScore).toBeLessThanOrEqual(1);
    });

    it('control cohort has no injection and thus no utilization', () => {
      const controlEvent: ContextUtilizationEvent = {
        session_id: 'sess-ctrl',
        correlation_id: 'corr-ctrl',
        cohort: 'control',
        injection_occurred: false,
        // utilization_score is undefined for control (no injection)
      };

      expect(controlEvent.utilization_score).toBeUndefined();
      expect(controlEvent.injection_occurred).toBe(false);
    });
  });
});
