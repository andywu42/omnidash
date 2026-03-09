/**
 * Cross-Repo Validation Event Types
 *
 * TypeScript interfaces for cross-repo validation events consumed from Kafka.
 * Used by the Validation Dashboard to display run history, violations, and trends.
 *
 * @see OMN-1907 - Cross-Repo Validation Dashboard Integration
 * @see OMN-1776 - Phase 2 event contracts (upstream)
 */

import { z } from 'zod';
import {
  resolveTopicName,
  SUFFIX_VALIDATION_RUN_STARTED,
  SUFFIX_VALIDATION_VIOLATIONS_BATCH,
  SUFFIX_VALIDATION_RUN_COMPLETED,
} from '@shared/topics';

// ============================================================================
// Topic Constants (resolved at runtime from canonical ONEX suffixes)
//
// Corrected format: onex.evt.validation.<event-name>.v1
// (was: onex.validation.cross_repo.<event>.v1 — non-canonical)
//
// WARNING: These canonical topic names require the upstream ONEX producer
// (omnibase_infra topic_resolver.py) to be deployed with matching topic
// names. If there is a deployment mismatch -- i.e. omnidash subscribes to
// the new canonical names before the producer emits on them -- validation
// events will be SILENTLY DROPPED (no error, no warning, just missing data
// on the dashboard). There is no dual-subscription or fallback; this is an
// atomic cutover that requires coordinated deployment.
//
// Old format: onex.validation.cross_repo.run.started.v1 (non-canonical)
// New format: onex.evt.validation.cross-repo-run-started.v1 (canonical, no env prefix)
//
// See platform_topic_suffixes.py for the matching producer-side suffixes.
// ============================================================================

/** Kafka topic for validation run started events */
export const VALIDATION_RUN_STARTED_TOPIC = resolveTopicName(SUFFIX_VALIDATION_RUN_STARTED);

/** Kafka topic for validation violations batch events */
export const VALIDATION_VIOLATIONS_BATCH_TOPIC = resolveTopicName(
  SUFFIX_VALIDATION_VIOLATIONS_BATCH
);

/** Kafka topic for validation run completed events */
export const VALIDATION_RUN_COMPLETED_TOPIC = resolveTopicName(SUFFIX_VALIDATION_RUN_COMPLETED);

/** WebSocket channel for validation events */
export const WS_CHANNEL_VALIDATION = 'validation';

// ============================================================================
// Violation Severity
// ============================================================================

/** Allowed violation severity levels, ordered from most to least severe. */
export const VIOLATION_SEVERITIES = ['error', 'warning', 'info'] as const;

/** Union type of valid violation severity strings. */
export type ViolationSeverity = (typeof VIOLATION_SEVERITIES)[number];

// ============================================================================
// Zod Schemas
// ============================================================================

/** Zod schema for the ValidationRunStarted Kafka event. */
export const ValidationRunStartedSchema = z.object({
  event_type: z.literal('ValidationRunStarted'),
  run_id: z.string(),
  repos: z.array(z.string()),
  validators: z.array(z.string()),
  triggered_by: z.string().optional(),
  timestamp: z.string().datetime(),
});

/** Zod schema for a single validation violation entry. */
export const ViolationSchema = z.object({
  rule_id: z.string(),
  severity: z.enum(VIOLATION_SEVERITIES),
  message: z.string(),
  repo: z.string(),
  file_path: z.string().optional(),
  line: z.number().optional(),
  validator: z.string(),
});

/** Zod schema for the ValidationViolationsBatch Kafka event. */
export const ValidationViolationsBatchSchema = z.object({
  event_type: z.literal('ValidationViolationsBatch'),
  run_id: z.string(),
  violations: z.array(ViolationSchema),
  batch_index: z.number(),
  timestamp: z.string().datetime(),
});

/** Zod schema for the ValidationRunCompleted Kafka event. */
export const ValidationRunCompletedSchema = z.object({
  event_type: z.literal('ValidationRunCompleted'),
  run_id: z.string(),
  status: z.enum(['passed', 'failed', 'error']),
  total_violations: z.number(),
  violations_by_severity: z.record(z.number()).optional(),
  duration_ms: z.number(),
  timestamp: z.string().datetime(),
});

// ============================================================================
// TypeScript Interfaces
// ============================================================================

export type ValidationRunStartedEvent = z.infer<typeof ValidationRunStartedSchema>;
export type Violation = z.infer<typeof ViolationSchema>;
export type ValidationViolationsBatchEvent = z.infer<typeof ValidationViolationsBatchSchema>;
export type ValidationRunCompletedEvent = z.infer<typeof ValidationRunCompletedSchema>;

/**
 * Reconstructed validation run aggregated from Kafka events.
 *
 * @property run_id - Unique identifier for the validation run
 * @property repos - List of repositories included in the run
 * @property validators - List of validator names that were executed
 * @property triggered_by - User or system that initiated the run
 * @property status - Current run status: running, passed, failed, or error
 * @property started_at - ISO-8601 timestamp when the run started
 * @property completed_at - ISO-8601 timestamp when the run finished
 * @property duration_ms - Total run duration in milliseconds
 * @property total_violations - Aggregate count of all violations found
 * @property violations_by_severity - Violation counts keyed by severity level
 * @property violations - Full list of individual violation records
 */
export interface ValidationRun {
  run_id: string;
  repos: string[];
  validators: string[];
  triggered_by?: string;
  status: 'running' | 'passed' | 'failed' | 'error';
  started_at: string;
  completed_at?: string;
  duration_ms?: number;
  total_violations: number;
  violations_by_severity?: Record<string, number>;
  violations: Violation[];
}

/**
 * Per-repo violation trend data point for a single date.
 *
 * @property date - ISO-8601 date string for this data point
 * @property errors - Number of error-severity violations on this date
 * @property warnings - Number of warning-severity violations on this date
 * @property infos - Number of info-severity violations on this date
 * @property total - Sum of all violations across severities
 */
export interface RepoTrendPoint {
  date: string;
  errors: number;
  warnings: number;
  infos: number;
  total: number;
}

/**
 * Per-repo violation trends over time.
 *
 * @property repo - Repository name this trend data belongs to
 * @property trend - Ordered list of trend data points by date
 * @property latest_run_id - Run ID of the most recent validation run for this repo
 */
export interface RepoTrends {
  repo: string;
  trend: RepoTrendPoint[];
  latest_run_id?: string;
}

// ============================================================================
// Lifecycle Tier & Candidate Types (OMN-2152)
// ============================================================================

/**
 * Lifecycle tiers that a validation rule/pattern candidate progresses through.
 * Ordered from least mature to most mature.
 */
export const LIFECYCLE_TIERS = [
  'observed',
  'suggested',
  'shadow_apply',
  'promoted',
  'default',
] as const;

/** Union type of valid lifecycle tier strings. */
export type LifecycleTier = (typeof LIFECYCLE_TIERS)[number];

/** Human-readable labels for each lifecycle tier. */
export const LIFECYCLE_TIER_LABELS: Record<LifecycleTier, string> = {
  observed: 'Observed',
  suggested: 'Suggested',
  shadow_apply: 'Shadow Apply',
  promoted: 'Promoted',
  default: 'Default',
};

/**
 * Candidate validation statuses within a lifecycle tier.
 */
export const CANDIDATE_STATUSES = ['pending', 'pass', 'fail', 'quarantine'] as const;

/** Union type of valid candidate status strings. */
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

/**
 * A single validation lifecycle candidate representing a pattern or rule
 * progressing through the lifecycle tiers.
 */
export interface LifecycleCandidate {
  /** Unique identifier for this candidate */
  candidate_id: string;
  /** Human-readable name of the rule or pattern */
  rule_name: string;
  /** Rule ID matching a validation rule (e.g. SCHEMA-001) */
  rule_id: string;
  /** Current lifecycle tier */
  tier: LifecycleTier;
  /** Current validation status within the tier */
  status: CandidateStatus;
  /** Repository where this candidate was discovered */
  source_repo: string;
  /** ISO-8601 timestamp when candidate entered current tier */
  entered_tier_at: string;
  /** ISO-8601 timestamp of last validation run for this candidate */
  last_validated_at: string;
  /** Number of consecutive passes at current tier */
  pass_streak: number;
  /** Number of consecutive failures at current tier */
  fail_streak: number;
  /** Total number of validation runs for this candidate */
  total_runs: number;
}

/**
 * Per-tier aggregated metrics for the lifecycle visualization.
 */
export interface LifecycleTierMetrics {
  /** The lifecycle tier */
  tier: LifecycleTier;
  /** Number of candidates currently at this tier */
  count: number;
  /** Breakdown of candidate statuses at this tier */
  by_status: Record<CandidateStatus, number>;
  /** Average days candidates spend at this tier before advancing */
  avg_days_at_tier: number;
  /** Rate at which candidates transition to the next tier (0-1) */
  transition_rate: number;
}

/**
 * Summary response for the lifecycle tab.
 */
export interface LifecycleSummary {
  /** Total number of tracked candidates */
  total_candidates: number;
  /** Per-tier breakdown */
  tiers: LifecycleTierMetrics[];
  /** Aggregate counts by candidate status across all tiers */
  by_status: Record<CandidateStatus, number>;
  /** Candidates list (paginated subset) */
  candidates: LifecycleCandidate[];
}

// ============================================================================
// Lifecycle Candidate Kafka Event Types (OMN-2333)
// ============================================================================

/**
 * Zod schema for the ValidationCandidateUpserted Kafka event.
 *
 * Emitted by the OMN-2018 artifact store when a lifecycle candidate is
 * created or updated. Omnidash projects this into the validation_candidates
 * read-model table.
 */
export const ValidationCandidateUpsertedSchema = z.object({
  event_type: z.literal('ValidationCandidateUpserted'),
  candidate_id: z.string(),
  rule_name: z.string(),
  rule_id: z.string(),
  tier: z.enum(['observed', 'suggested', 'shadow_apply', 'promoted', 'default']),
  status: z.enum(['pending', 'pass', 'fail', 'quarantine']),
  source_repo: z.string(),
  entered_tier_at: z.string().datetime(),
  last_validated_at: z.string().datetime(),
  pass_streak: z.number().int().min(0),
  fail_streak: z.number().int().min(0),
  total_runs: z.number().int().min(0),
  timestamp: z.string().datetime(),
});

export type ValidationCandidateUpsertedEvent = z.infer<typeof ValidationCandidateUpsertedSchema>;

/** Type guard for ValidationCandidateUpserted Kafka events. */
export function isValidationCandidateUpserted(
  event: unknown
): event is ValidationCandidateUpsertedEvent {
  return ValidationCandidateUpsertedSchema.safeParse(event).success;
}

// ============================================================================
// Type Guards
// ============================================================================

/** Type guard that checks whether an unknown value is a valid ValidationRunStarted event. */
export function isValidationRunStarted(event: unknown): event is ValidationRunStartedEvent {
  return ValidationRunStartedSchema.safeParse(event).success;
}

/** Type guard that checks whether an unknown value is a valid ValidationViolationsBatch event. */
export function isValidationViolationsBatch(
  event: unknown
): event is ValidationViolationsBatchEvent {
  return ValidationViolationsBatchSchema.safeParse(event).success;
}

/** Type guard that checks whether an unknown value is a valid ValidationRunCompleted event. */
export function isValidationRunCompleted(event: unknown): event is ValidationRunCompletedEvent {
  return ValidationRunCompletedSchema.safeParse(event).success;
}
