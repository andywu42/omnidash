/**
 * Centralized health status mapping utility
 *
 * Standardizes health terminology across the codebase:
 * - Semantic-style: healthy, warning, critical, unknown
 * - Service-style: passing, up, online, degraded, unhealthy
 * - Mock data: healthy, degraded, unhealthy
 */

/** Canonical semantic health levels (for UI display) */
export type SemanticHealthLevel = 'healthy' | 'warning' | 'critical' | 'unknown';

/** All possible health status strings that might be encountered */
export type AnyHealthStatus =
  | SemanticHealthLevel
  | 'passing'
  | 'up'
  | 'online'
  | 'degraded'
  | 'slow'
  | 'unhealthy'
  | 'dead'
  | 'down'
  | 'failed'
  | 'error';

/**
 * Severity order for health statuses (lower = more severe)
 * Useful for sorting items by health priority (critical issues first)
 */
export const HEALTH_SEVERITY_ORDER: Record<SemanticHealthLevel, number> = {
  critical: 0,
  warning: 1,
  healthy: 2,
  unknown: 3,
};

/**
 * Status category Sets for O(1) lookup performance
 * Used by normalizeHealthStatus for efficient status categorization
 */
const HEALTHY_STATUSES: Set<string> = new Set([
  'passing',
  'healthy',
  'up',
  'online',
  'ok',
  'good',
  'active',
]);

const WARNING_STATUSES: Set<string> = new Set([
  'warning',
  'degraded',
  'slow',
  'warn',
  'caution',
  'impaired',
]);

const CRITICAL_STATUSES: Set<string> = new Set([
  'critical',
  'unhealthy',
  'dead',
  'down',
  'failed',
  'error',
  'failing',
  'offline',
  'unavailable',
]);

/**
 * Normalize any health status string to a canonical semantic level
 *
 * Mappings:
 * - healthy: passing, healthy, up, online, ok, good, active
 * - warning: warning, degraded, slow, warn, caution, impaired
 * - critical: critical, unhealthy, dead, down, failed, error, failing, offline, unavailable
 * - unknown: everything else
 */
export function normalizeHealthStatus(status: string | null | undefined): SemanticHealthLevel {
  if (!status) {
    return 'unknown';
  }

  const normalized = status.toLowerCase().trim();

  if (HEALTHY_STATUSES.has(normalized)) {
    return 'healthy';
  }

  if (WARNING_STATUSES.has(normalized)) {
    return 'warning';
  }

  if (CRITICAL_STATUSES.has(normalized)) {
    return 'critical';
  }

  return 'unknown';
}

/**
 * Get a human-readable label for a health status
 */
export function getHealthLabel(status: SemanticHealthLevel): string {
  const labels: Record<SemanticHealthLevel, string> = {
    healthy: 'Healthy',
    warning: 'Warning',
    critical: 'Critical',
    unknown: 'Unknown',
  };
  return labels[status];
}

/**
 * Get the Tailwind CSS color class for a health status
 * Returns the base color name for use in Tailwind utilities
 */
export function getHealthColor(status: SemanticHealthLevel): string {
  const colors: Record<SemanticHealthLevel, string> = {
    healthy: 'green',
    warning: 'yellow',
    critical: 'red',
    unknown: 'gray',
  };
  return colors[status];
}

/**
 * Get the full Tailwind CSS text color class for a health status
 */
export function getHealthTextClass(status: SemanticHealthLevel): string {
  const classes: Record<SemanticHealthLevel, string> = {
    healthy: 'text-green-500',
    warning: 'text-yellow-500',
    critical: 'text-red-500',
    unknown: 'text-gray-500',
  };
  return classes[status];
}

/**
 * Get the full Tailwind CSS background color class for a health status
 */
export function getHealthBgClass(status: SemanticHealthLevel): string {
  const classes: Record<SemanticHealthLevel, string> = {
    healthy: 'bg-green-500',
    warning: 'bg-yellow-500',
    critical: 'bg-red-500',
    unknown: 'bg-gray-500',
  };
  return classes[status];
}

/**
 * Get the full Tailwind CSS background color class with opacity for badges
 */
export function getHealthBadgeClass(status: SemanticHealthLevel): string {
  const classes: Record<SemanticHealthLevel, string> = {
    healthy: 'bg-green-500/10 text-green-500 border-green-500/20',
    warning: 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20',
    critical: 'bg-red-500/10 text-red-500 border-red-500/20',
    unknown: 'bg-gray-500/10 text-gray-500 border-gray-500/20',
  };
  return classes[status];
}

/**
 * Check if a health status represents a healthy state
 */
export function isHealthy(status: string | null | undefined): boolean {
  return normalizeHealthStatus(status) === 'healthy';
}

/**
 * Check if a health status represents a critical state
 */
export function isCritical(status: string | null | undefined): boolean {
  return normalizeHealthStatus(status) === 'critical';
}

/**
 * Check if a health status represents a warning state
 */
export function isWarning(status: string | null | undefined): boolean {
  return normalizeHealthStatus(status) === 'warning';
}

/**
 * Sort health statuses by severity (critical first, then warning, then healthy, then unknown)
 */
export function sortByHealthSeverity<T>(
  items: T[],
  getStatus: (item: T) => string | null | undefined
): T[] {
  return [...items].sort((a, b) => {
    const statusA = normalizeHealthStatus(getStatus(a));
    const statusB = normalizeHealthStatus(getStatus(b));
    return HEALTH_SEVERITY_ORDER[statusA] - HEALTH_SEVERITY_ORDER[statusB];
  });
}
