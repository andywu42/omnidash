import { z } from 'zod';
import { AgentExecutionTracker } from './agent-execution-tracker';

// Schema for polymorphic agent routing decisions
export const RoutingDecisionSchema = z.object({
  query: z.string(),
  selectedAgent: z.string(),
  confidence: z.number().min(0).max(1),
  strategy: z.string(),
  alternatives: z.array(
    z.object({
      agent: z.string(),
      confidence: z.number(),
      reason: z.string(),
    })
  ),
  reasoning: z.string(),
  routingTime: z.number(),
  context: z.record(z.any()).optional(),
});

export type RoutingDecision = z.infer<typeof RoutingDecisionSchema>;

// Polymorphic agent integration — reads real execution data only.
// Mock simulation methods (simulateRoutingDecision, executeAgent) removed in OMN-7730.
export class PolymorphicAgentIntegration {
  /**
   * Get routing statistics from real execution data
   */
  static getRoutingStatistics() {
    const executions = AgentExecutionTracker.getRecentExecutions(100);

    const stats = {
      totalDecisions: executions.length,
      avgConfidence: 0,
      avgRoutingTime: 0,
      strategyBreakdown: {} as Record<string, number>,
      agentBreakdown: {} as Record<string, number>,
      successRate: 0,
    };

    if (executions.length === 0) return stats;

    let totalConfidence = 0;
    let totalRoutingTime = 0;
    let successfulExecutions = 0;

    executions.forEach((execution) => {
      if (execution.routingDecision) {
        totalConfidence += execution.routingDecision.confidence;
        totalRoutingTime += execution.routingDecision.routingTime || 0;

        const strategy = execution.routingDecision.strategy;
        stats.strategyBreakdown[strategy] = (stats.strategyBreakdown[strategy] || 0) + 1;
      }

      stats.agentBreakdown[execution.agentId] = (stats.agentBreakdown[execution.agentId] || 0) + 1;

      if (execution.status === 'completed' && execution.result?.success) {
        successfulExecutions++;
      }
    });

    stats.avgConfidence = totalConfidence / executions.length;
    stats.avgRoutingTime = totalRoutingTime / executions.length;
    stats.successRate = (successfulExecutions / executions.length) * 100;

    return stats;
  }

  /**
   * Get agent performance comparison
   */
  static getAgentPerformanceComparison() {
    const agents = [
      'agent-api-architect',
      'agent-debug-intelligence',
      'agent-frontend-developer',
      'agent-performance',
      'agent-testing',
      'agent-polymorphic-agent',
    ];

    return agents.map((agentId) => {
      const performance = AgentExecutionTracker.getAgentPerformanceMetrics(agentId);
      const executions = AgentExecutionTracker.getExecutionsForAgent(agentId, 50);

      const routingStats = executions
        .filter((exec) => exec.routingDecision)
        .reduce(
          (acc, exec) => {
            if (exec.routingDecision) {
              acc.totalConfidence += exec.routingDecision.confidence;
              acc.totalRoutingTime += exec.routingDecision.routingTime || 0;
              acc.count++;
            }
            return acc;
          },
          { totalConfidence: 0, totalRoutingTime: 0, count: 0 }
        );

      return {
        agentId,
        agentName: agentId.replace('agent-', '').replace('-', ' '),
        performance,
        routingStats: {
          avgConfidence:
            routingStats.count > 0 ? routingStats.totalConfidence / routingStats.count : 0,
          avgRoutingTime:
            routingStats.count > 0 ? routingStats.totalRoutingTime / routingStats.count : 0,
          totalDecisions: routingStats.count,
        },
      };
    });
  }
}
