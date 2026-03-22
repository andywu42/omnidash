/**
 * Health Probe Contract (OMN-5820)
 *
 * Defines which data sources should be "live" under each infrastructure
 * profile. Used by integration tests and the integration sweep to verify
 * that health regressions are caught automatically rather than discovered
 * during manual dashboard checks.
 *
 * Profile hierarchy:
 *   core       — postgres + redpanda only (infra-up)
 *   runtime    — core + omninode-runtime services (infra-up-runtime)
 *   full       — runtime + all optional services (secrets, memgraph, etc.)
 *
 * Each profile lists the data source keys (matching the keys returned by
 * GET /api/health/data-sources) that MUST report "live" when that profile
 * is active. Sources not listed are allowed to be mock/offline/idle.
 */

import type { DataSourceStatus } from '../server/health-data-sources-routes';

// ---------------------------------------------------------------------------
// Profile definitions
// ---------------------------------------------------------------------------

export type InfraProfile = 'core' | 'runtime' | 'full';

export interface ProfileExpectation {
  /** Human-readable description of what this profile provides. */
  description: string;
  /**
   * Data source keys that MUST be "live" when this profile is active.
   * Any source in this list reporting "mock", "error", or "offline" is a
   * regression that should fail the integration health check.
   */
  mustBeLive: readonly string[];
  /**
   * Data source keys that are acceptable in non-live states under this
   * profile. Sources not in mustBeLive and not in acceptableIdle are
   * treated as "don't care" (no assertion either way).
   */
  acceptableIdle: readonly string[];
}

/**
 * Statuses that count as "healthy" — a source in mustBeLive reporting one
 * of these statuses passes the health check.
 */
export const HEALTHY_STATUSES: ReadonlySet<DataSourceStatus> = new Set([
  'live',
  'expected_idle_local',
  'not_applicable',
]);

/**
 * Statuses that indicate a regression — a source in mustBeLive reporting
 * one of these statuses should fail the health check.
 */
export const REGRESSION_STATUSES: ReadonlySet<DataSourceStatus> = new Set([
  'mock',
  'error',
  'offline',
]);

// ---------------------------------------------------------------------------
// Profile → expected data source status mapping
// ---------------------------------------------------------------------------

export const HEALTH_PROBE_CONTRACT: Record<InfraProfile, ProfileExpectation> = {
  /**
   * Core profile: only postgres and redpanda are running.
   * The event bus consumer can connect but no upstream producers are active,
   * so only structural sources (topic parity, env sync) are checkable.
   */
  core: {
    description: 'PostgreSQL + Redpanda only (infra-up)',
    mustBeLive: ['topicParity'],
    acceptableIdle: [
      'eventBus',
      'effectiveness',
      'extraction',
      'baselines',
      'costTrends',
      'intents',
      'nodeRegistry',
      'correlationTrace',
      'validation',
      'insights',
      'patterns',
      'executionGraph',
      'enforcement',
      'envSync',
    ],
  },

  /**
   * Runtime profile: core + omninode-runtime services.
   * Agent event producers are running, so event-bus-derived sources should
   * become live once at least one agent session has occurred.
   */
  runtime: {
    description: 'Core + omninode-runtime services (infra-up-runtime)',
    mustBeLive: ['eventBus', 'correlationTrace', 'topicParity'],
    acceptableIdle: [
      // These require active agent sessions or specific upstream services
      // that may not be running even with the runtime profile.
      'effectiveness',
      'extraction',
      'baselines',
      'costTrends',
      'intents',
      'nodeRegistry',
      'validation',
      'insights',
      'patterns',
      'executionGraph',
      'enforcement',
      'envSync',
    ],
  },

  /**
   * Full profile: all services running including secrets, memgraph, etc.
   * Everything should be live after at least one agent session.
   */
  full: {
    description: 'All services including secrets and optional profiles',
    mustBeLive: [
      'eventBus',
      'effectiveness',
      'extraction',
      'correlationTrace',
      'topicParity',
      'enforcement',
      'envSync',
    ],
    acceptableIdle: [
      // These depend on specific upstream producers that may not have
      // emitted yet even with all services running.
      'baselines',
      'costTrends',
      'intents',
      'nodeRegistry',
      'validation',
      'insights',
      'patterns',
      'executionGraph',
    ],
  },
} as const;

/**
 * All data source keys that the health endpoint is expected to return.
 * Used by tests to verify completeness.
 */
export const ALL_DATA_SOURCE_KEYS = [
  'eventBus',
  'effectiveness',
  'extraction',
  'baselines',
  'costTrends',
  'intents',
  'nodeRegistry',
  'correlationTrace',
  'validation',
  'insights',
  'patterns',
  'executionGraph',
  'enforcement',
  'envSync',
  'topicParity',
] as const;

export type DataSourceKey = (typeof ALL_DATA_SOURCE_KEYS)[number];
