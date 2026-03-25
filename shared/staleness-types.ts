/**
 * Staleness types and threshold constants (OMN-6397)
 *
 * Shared between the frontend StalenessIndicator component and the
 * backend staleness API endpoint.
 */

// ---------------------------------------------------------------------------
// Severity levels
// ---------------------------------------------------------------------------

export type StalenessSeverity = 'fresh' | 'aging' | 'stale' | 'critical';

// ---------------------------------------------------------------------------
// Thresholds (milliseconds)
// ---------------------------------------------------------------------------

/** < 1 hour: fresh (green) */
export const FRESH_THRESHOLD_MS = 60 * 60 * 1000;

/** 1-6 hours: aging (yellow) */
export const AGING_THRESHOLD_MS = 6 * 60 * 60 * 1000;

/** 6-24 hours: stale (orange) */
export const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/** > 24 hours: critical (red) */
// Anything beyond STALE_THRESHOLD_MS is critical

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StalenessInfo {
  /** Feature or table name */
  name: string;
  /** ISO timestamp of last data update, or null if never updated */
  lastUpdated: string | null;
  /** Whether the data is considered stale */
  stale: boolean;
  /** Severity level based on age */
  severityLevel: StalenessSeverity;
}

export interface StalenessApiResponse {
  features: Record<string, StalenessInfo>;
  checkedAt: string;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Determine staleness severity from a lastUpdated timestamp.
 */
export function getStaleSeverity(lastUpdated: string | null | undefined): StalenessSeverity {
  if (!lastUpdated) return 'critical';

  const ageMs = Date.now() - new Date(lastUpdated).getTime();

  if (ageMs < 0) return 'fresh'; // future timestamp = just updated
  if (ageMs < FRESH_THRESHOLD_MS) return 'fresh';
  if (ageMs < AGING_THRESHOLD_MS) return 'aging';
  if (ageMs < STALE_THRESHOLD_MS) return 'stale';
  return 'critical';
}

/**
 * Format a duration in milliseconds to a human-readable "N ago" string.
 */
export function formatAge(lastUpdated: string | null | undefined): string {
  if (!lastUpdated) return 'Never updated';

  const ageMs = Date.now() - new Date(lastUpdated).getTime();

  if (ageMs < 0) return 'Just now';
  if (ageMs < 60_000) return 'Just now';

  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
