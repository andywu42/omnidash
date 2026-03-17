/**
 * Intelligence route module index.
 * Mounts all domain-specific route groups onto the intelligence router.
 *
 * Each module exports a registerXxxRoutes(router) function that registers
 * its routes onto the shared Express router.
 */
export { registerPatternRoutes } from './pattern-routes';
export { registerAgentRoutes } from './agent-routes';
export { registerHealthRoutes } from './health-routes';
export { registerMetricsRoutes } from './metrics-routes';
export { registerComplianceRoutes } from './compliance-routes';
export { registerTraceRoutes } from './trace-routes';
export { registerPipelineRoutes } from './pipeline-routes';
export { registerMockRoutes } from './mock-routes';
