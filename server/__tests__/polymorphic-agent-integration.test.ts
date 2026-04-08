import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentExecutionTracker } from '../agent-execution-tracker';
import { PolymorphicAgentIntegration } from '../polymorphic-agent-integration';

vi.mock('../agent-execution-tracker', () => {
  const startExecution = vi.fn();
  const updateExecutionStatus = vi.fn();
  const getRecentExecutions = vi.fn();
  const getAgentPerformanceMetrics = vi.fn();
  const getExecutionsForAgent = vi.fn();
  return {
    AgentExecutionTracker: {
      startExecution,
      updateExecutionStatus,
      getRecentExecutions,
      getAgentPerformanceMetrics,
      getExecutionsForAgent,
    },
  };
});

describe('PolymorphicAgentIntegration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getRoutingStatistics', () => {
    it('should compute averages and success rates from tracker data', () => {
      vi.mocked(AgentExecutionTracker.getRecentExecutions).mockReturnValue([
        {
          agentId: 'agent-api-architect',
          status: 'completed',
          result: { success: true },
          routingDecision: {
            confidence: 0.9,
            routingTime: 50,
            strategy: 'enhanced_fuzzy_matching',
          },
        },
        {
          agentId: 'agent-api-architect',
          status: 'failed',
          result: { success: false },
          routingDecision: { confidence: 0.7, routingTime: 70, strategy: 'fallback_routing' },
        },
      ]);

      const stats = PolymorphicAgentIntegration.getRoutingStatistics();

      expect(stats.totalDecisions).toBe(2);
      expect(stats.avgConfidence).toBeCloseTo(0.8);
      expect(stats.avgRoutingTime).toBeCloseTo(60);
      expect(stats.successRate).toBeCloseTo(50);
      expect(stats.strategyBreakdown).toHaveProperty('enhanced_fuzzy_matching');
    });

    it('should return defaults when no executions recorded', () => {
      vi.mocked(AgentExecutionTracker.getRecentExecutions).mockReturnValue([]);

      const stats = PolymorphicAgentIntegration.getRoutingStatistics();

      expect(stats.totalDecisions).toBe(0);
      expect(stats.avgConfidence).toBe(0);
      expect(stats.successRate).toBe(0);
    });
  });

  describe('getAgentPerformanceComparison', () => {
    it('should include performance metrics and routing stats per agent', () => {
      vi.mocked(AgentExecutionTracker.getAgentPerformanceMetrics).mockReturnValue({
        avgQualityScore: 0.95,
        popularity: 80,
        efficiency: 75,
        lastUsed: Date.now(),
      });
      vi.mocked(AgentExecutionTracker.getExecutionsForAgent).mockReturnValue([
        {
          routingDecision: { confidence: 0.9, routingTime: 40 },
        },
        {
          routingDecision: { confidence: 0.7, routingTime: 60 },
        },
      ]);

      const comparison = PolymorphicAgentIntegration.getAgentPerformanceComparison();

      expect(comparison.length).toBeGreaterThan(0);
      expect(comparison[0]).toHaveProperty('performance');
      expect(comparison[0].routingStats.avgConfidence).toBeGreaterThan(0);
    });
  });
});
