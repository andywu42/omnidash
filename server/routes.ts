import type { Express } from 'express';
import { createServer, type Server } from 'http';
import { intelligenceRouter } from './intelligence-routes';
import savingsRoutes from './savings-routes';
import agentRegistryRoutes from './agent-registry-routes';
import { chatRouter } from './chat-routes';
import eventBusRoutes from './event-bus-routes';
import registryRoutes from './registry-routes';
import playbackRoutes from './playback-routes';
import patternsRoutes from './patterns-routes';
import validationRoutes from './validation-routes';
import extractionRoutes from './extraction-routes';
import effectivenessRoutes from './effectiveness-routes';
import { createProjectionRoutes } from './projection-routes';
import { projectionService } from './projection-bootstrap';
import baselinesRoutes from './baselines-routes';
import costRoutes from './cost-routes';
import intentRoutes from './intent-routes';
import { createGoldenPathRoutes } from './golden-path-routes';
import enforcementRoutes from './enforcement-routes';
import executionRoutes from './execution-routes';
import enrichmentRoutes from './enrichment-routes';
import topicCatalogRoutes from './topic-catalog-routes';
import healthDataSourcesRoutes from './health-data-sources-routes';
import llmRoutingRoutes from './llm-routing-routes';
import decisionRecordsRoutes from './decision-records-routes';
import delegationRoutes from './delegation-routes';
import statusRoutes, { linearSnapshotRouter } from './status-routes';
// Wave 2 routes (OMN-2602)
import gateDecisionsRoutes from './gate-decisions-routes';
import epicRunRoutes from './epic-run-routes';
import prWatchRoutes from './pr-watch-routes';
import pipelineBudgetRoutes from './pipeline-budget-routes';
import debugEscalationRoutes from './debug-escalation-routes';
// CI Intelligence routes (OMN-5282)
import ciIntelRoutes from './ci-intel-routes';
import objectiveRoutes from './objective-routes';
// CDQA gate routes (OMN-3190)
import cdqaGatesRoutes from './cdqa-gates-routes';
// Integration command center routes (OMN-3192)
import pipelineHealthRoutes from './pipeline-health-routes';
import eventBusHealthRoutes from './event-bus-health-routes';
// Plan reviewer routes (OMN-3324)
import planReviewerRoutes from './plan-reviewer-routes';
// Routing config routes (OMN-3445)
import routingConfigRoutes from './routing-config-routes';
// Worker health routes (OMN-3598)
import workerHealthRoutes from './worker-health-routes';
// LLM Health Dashboard routes (OMN-5279)
import llmHealthRoutes from './llm-health-routes';
// Schema health endpoint (OMN-3751)
import schemaHealthRoutes from './schema-health';
// Model Efficiency Index routes (OMN-3937)
import modelEfficiencyRoutes from './model-efficiency-routes';
// Correlation trace span routes (OMN-5047)
import traceRoutes from './trace-routes';
// Pattern lifecycle dashboard routes (OMN-5283)
import patternLifecycleRoutes from './pattern-lifecycle-routes';
// Session outcome and phase metrics routes (OMN-5184)
import { sessionOutcomeRoutes } from './session-outcome-routes';
import { phaseMetricsRoutes } from './phase-metrics-routes';
// Topic topology routes (OMN-5294)
import topologyRoutes from './topology-routes';
// DoD verification dashboard routes (OMN-5200)
import dodRoutes from './dod-routes';
// Intent drift routes (OMN-5281)
import intentDriftRoutes from './intent-drift-routes';
// Prometheus metrics endpoint (OMN-4609)
import { createMetricsRouter } from './metrics-routes';
import type { DataSourcesHealthResponse } from './health-data-sources-routes';

export async function registerRoutes(app: Express): Promise<Server> {
  // put application routes here
  // prefix all routes with /api

  // Mount intelligence routes for agent observability and metrics
  app.use('/api/intelligence', intelligenceRouter);

  // Mount savings routes for compute and token savings tracking
  app.use('/api/savings', savingsRoutes);

  // Mount agent registry routes for agent discovery and management
  app.use('/api/agents', agentRegistryRoutes);

  // Mount chat routes for AI assistant interactions
  app.use('/api/chat', chatRouter);

  // Mount event bus routes for event querying and statistics
  app.use('/api/event-bus', eventBusRoutes);

  // Mount registry routes for ONEX node registry discovery (contract-driven dashboards)
  app.use('/api/registry', registryRoutes);

  // Mount demo playback routes for recorded event replay
  app.use('/api/demo', playbackRoutes);

  // Mount patterns routes for learned patterns API (OMN-1797)
  app.use('/api/patterns', patternsRoutes);

  // Mount validation routes for cross-repo validation dashboard (OMN-1907)
  app.use('/api/validation', validationRoutes);

  // Mount extraction routes for pattern extraction pipeline dashboard (OMN-1804)
  app.use('/api/extraction', extractionRoutes);

  // Mount effectiveness routes for injection effectiveness dashboard (OMN-1891)
  app.use('/api/effectiveness', effectivenessRoutes);

  // Mount projection routes for server-side materialized views (OMN-2095 / OMN-2096 / OMN-2097)
  app.use('/api/projections', createProjectionRoutes(projectionService));

  // Mount baselines routes for cost + outcome comparison dashboard (OMN-2156)
  app.use('/api/baselines', baselinesRoutes);

  // Mount cost trend routes for LLM cost and token usage dashboard (OMN-2242)
  app.use('/api/costs', costRoutes);

  // Mount intent routes for real-time intent classification dashboard
  app.use('/api/intents', intentRoutes);

  // Mount pattern enforcement routes for enforcement metrics dashboard (OMN-2275)
  app.use('/api/enforcement', enforcementRoutes);

  // Mount execution graph routes for live ONEX node graph page (OMN-2302)
  app.use('/api/executions', executionRoutes);

  // Mount context enrichment routes for enrichment metrics dashboard (OMN-2280)
  app.use('/api/enrichment', enrichmentRoutes);

  // Mount topic catalog routes for catalog status and warnings (OMN-2315)
  app.use('/api/catalog', topicCatalogRoutes);

  // Mount data-source health audit endpoint (OMN-2307)
  app.use('/api/health', healthDataSourcesRoutes);

  // Mount LLM routing effectiveness routes (OMN-2279)
  app.use('/api/llm-routing', llmRoutingRoutes);

  // Mount decision records routes for Why This Happened panel (OMN-2469)
  app.use('/api/decisions', decisionRecordsRoutes);

  // Mount delegation metrics routes for delegation dashboard (OMN-2650)
  app.use('/api/delegation', delegationRoutes);

  // Mount status dashboard routes (OMN-2658)
  app.use('/api/status', statusRoutes);

  // Mount objective evaluation routes (OMN-2583)
  app.use('/api/objective', objectiveRoutes);
  // Debug/manual ingress for Linear snapshots (OMN-2658)
  app.use('/api/linear', linearSnapshotRouter);

  // Mount Wave 2 omniclaude state event routes (OMN-2602)
  app.use('/api/gate-decisions', gateDecisionsRoutes);
  app.use('/api/epic-run', epicRunRoutes);
  app.use('/api/pr-watch', prWatchRoutes);
  app.use('/api/pipeline-budget', pipelineBudgetRoutes);
  app.use('/api/debug-escalation', debugEscalationRoutes);

  // CI Intelligence dashboard routes (OMN-5282)
  app.use('/api/ci-intel', ciIntelRoutes);

  // CDQA gate dashboard routes (OMN-3190)
  app.use('/api/cdqa-gates', cdqaGatesRoutes);

  // Integration command center routes (OMN-3192)
  app.use('/api/pipeline-health', pipelineHealthRoutes);
  app.use('/api/event-bus-health', eventBusHealthRoutes);

  // Plan reviewer routes (OMN-3324)
  app.use('/api/plan-reviewer', planReviewerRoutes);

  // Routing config routes (OMN-3445)
  app.use('/api/routing-config', routingConfigRoutes);

  // Worker health routes (OMN-3598)
  app.use('/api/worker-health', workerHealthRoutes);

  // LLM Health Dashboard routes (OMN-5279)
  app.use('/api/llm-health', llmHealthRoutes);

  // Schema health endpoint (OMN-3751)
  app.use('/api/health', schemaHealthRoutes);

  // Model Efficiency Index routes (OMN-3937)
  app.use('/api/model-efficiency', modelEfficiencyRoutes);

  // Correlation trace span routes (OMN-5047)
  app.use('/api/traces', traceRoutes);

  // Pattern lifecycle dashboard routes (OMN-5283)
  app.use('/api/pattern-lifecycle', patternLifecycleRoutes);

  // Session outcome and phase metrics routes (OMN-5184)
  app.use('/api/session-outcomes', sessionOutcomeRoutes);
  app.use('/api/phase-metrics', phaseMetricsRoutes);

  // Topic topology routes (OMN-5294)
  app.use('/api/topology', topologyRoutes);

  // DoD verification dashboard routes (OMN-5200)
  app.use('/api/dod', dodRoutes);

  // Intent drift routes (OMN-5281)
  app.use('/api/intent-drift', intentDriftRoutes);

  // Prometheus metrics endpoint (OMN-4609)
  // Route: GET /metrics — NO authentication. Prometheus scrapes without tokens.
  // getHealth fetches /api/health/data-sources internally via loopback.
  // PORT defaults to 3000 matching the server's own listen port.
  app.use(
    '/metrics',
    createMetricsRouter(async (): Promise<DataSourcesHealthResponse> => {
      const port = process.env.PORT ?? '3000';
      const res = await fetch(`http://localhost:${port}/api/health/data-sources`);
      if (!res.ok) throw new Error(`Health probe returned ${res.status}`);
      return res.json() as Promise<DataSourcesHealthResponse>;
    })
  );

  // Conditionally mount golden path test routes (OMN-2079)
  // Only enabled when ENABLE_TEST_ROUTES=true AND (NODE_ENV=test OR OMNIDASH_TEST_MODE=true)
  const goldenPathRoutes = createGoldenPathRoutes();
  if (goldenPathRoutes) {
    app.use('/api/test/golden-path', goldenPathRoutes);
  }

  const httpServer = createServer(app);

  return httpServer;
}
