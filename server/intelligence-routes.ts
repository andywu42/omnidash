/**
 * Intelligence routes — thin mount file.
 *
 * All route implementations have been decomposed into domain-specific modules
 * under server/routes/intelligence/ (OMN-5193). This file creates the shared
 * router, registers all sub-modules, and mounts the alert sub-router.
 *
 * Route modules:
 *   - mock-routes.ts      — adapter smoke tests, analysis endpoint
 *   - agent-routes.ts     — agent summary, actions, routing, transformations
 *   - health-routes.ts    — health checks, runtime identity, service health
 *   - pattern-routes.ts   — pattern discovery, lineage, PATLEARN
 *   - metrics-routes.ts   — operations metrics, developer experience, performance
 *   - compliance-routes.ts — ONEX compliance, document access
 *   - trace-routes.ts     — correlation traces, execution traces
 *   - pipeline-routes.ts  — pattern injections, lifecycle, attributions
 *
 * Data access tracking (routes using direct DB vs ProjectionService):
 *   Direct DB (getIntelligenceDb):
 *     - agent-routes: agents/summary fallback, routing-strategy, transformations/summary
 *     - health-routes: manifest-injection, platform/services
 *     - pattern-routes: all endpoints (pattern_lineage_nodes, pattern_quality_metrics, etc.)
 *     - metrics-routes: operations-per-minute, quality-impact, developer/*, task-velocity
 *     - compliance-routes: code/compliance, documents/top-accessed
 *     - trace-routes: traces/recent, trace/:correlationId, execution/:correlationId
 *     - pipeline-routes: injections/*, lifecycle/*, attributions/*
 *   In-memory (eventConsumer):
 *     - agent-routes: agents/summary (primary), actions/recent (primary),
 *       agents/:agent/actions, routing/decisions, transformations/recent, agents/:agentName/details
 *     - health-routes: health, read-model/status
 *     - metrics-routes: performance/metrics, performance/summary
 */
import { Router } from 'express';
import {
  registerMockRoutes,
  registerAgentRoutes,
  registerHealthRoutes,
  registerPatternRoutes,
  registerMetricsRoutes,
  registerComplianceRoutes,
  registerTraceRoutes,
  registerPipelineRoutes,
} from './routes/intelligence';

export const intelligenceRouter = Router();

// Register all domain-specific route groups
registerMockRoutes(intelligenceRouter);
registerAgentRoutes(intelligenceRouter);
registerHealthRoutes(intelligenceRouter);
registerPatternRoutes(intelligenceRouter);
registerMetricsRoutes(intelligenceRouter);
registerComplianceRoutes(intelligenceRouter);
registerTraceRoutes(intelligenceRouter);
registerPipelineRoutes(intelligenceRouter);

// Mount alert sub-router
import { alertRouter } from './alert-routes';
intelligenceRouter.use('/alerts', alertRouter);
