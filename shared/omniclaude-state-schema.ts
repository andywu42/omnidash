/**
 * OmniClaude State Event Drizzle Schemas (OMN-2602)
 *
 * Defines Drizzle pgTable objects for the 5 Wave 2 read-model tables created by
 * read-model-consumer.ts when it projects omniclaude state-change events.
 *
 * These schemas are the single source of truth for:
 *   - TypeScript row types (via Drizzle's InferSelectModel)
 *   - Zod validation schemas (via drizzle-zod createSelectSchema)
 *
 * Tables are populated by read-model-consumer.ts; Drizzle is used here for
 * type inference and validation only (queries use raw sql`` for flexibility).
 *
 * Source Kafka topics:
 *   onex.evt.omniclaude.gate-decision.v1          → gateDecisions (gate_decisions)
 *   onex.evt.omniclaude.epic-run-updated.v1        → epicRunEvents (epic_run_events)
 *                                                  → epicRunLease  (epic_run_lease)
 *   onex.evt.omniclaude.pr-watch-updated.v1        → prWatchState  (pr_watch_state)
 *   onex.evt.omniclaude.budget-cap-hit.v1          → pipelineBudgetState (pipeline_budget_state)
 *   onex.evt.omniclaude.circuit-breaker-tripped.v1 → debugEscalationCounts (debug_escalation_counts)
 */

import { pgTable, text, integer, boolean, timestamp, uuid, jsonb } from 'drizzle-orm/pg-core';
import type { InferSelectModel } from 'drizzle-orm';
import { createSelectSchema } from 'drizzle-zod';
import { z } from 'zod';

// ============================================================================
// Gate Decisions
// ============================================================================

export const gateDecisions = pgTable('gate_decisions', {
  correlation_id: text('correlation_id').primaryKey(),
  pr_number: integer('pr_number'),
  repo: text('repo'),
  gate_name: text('gate_name').notNull(),
  outcome: text('outcome').notNull(),
  blocking: boolean('blocking').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
});

export const gateDecisionRowSchema = createSelectSchema(gateDecisions, {
  // created_at is returned as text from the SQL query (::text cast)
  created_at: z.coerce.string(),
});
export type GateDecisionRow = Omit<InferSelectModel<typeof gateDecisions>, 'created_at'> & {
  created_at: string;
};

export const gateDecisionSummarySchema = z.object({
  total: z.number(),
  passed: z.number(),
  failed: z.number(),
  blocked: z.number(),
  pass_rate: z.number(),
});
export type GateDecisionSummary = z.infer<typeof gateDecisionSummarySchema>;

export const gateDecisionsPayloadSchema = z.object({
  recent: z.array(gateDecisionRowSchema),
  summary: gateDecisionSummarySchema,
});
export type GateDecisionsPayload = z.infer<typeof gateDecisionsPayloadSchema>;

// ============================================================================
// Epic Run Events
// ============================================================================

export const epicRunEvents = pgTable('epic_run_events', {
  correlation_id: text('correlation_id').primaryKey(),
  epic_run_id: text('epic_run_id').notNull(),
  event_type: text('event_type').notNull(),
  ticket_id: text('ticket_id'),
  repo: text('repo'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
});

export const epicRunLease = pgTable('epic_run_lease', {
  epic_run_id: text('epic_run_id').primaryKey(),
  lease_holder: text('lease_holder').notNull(),
  lease_expires_at: timestamp('lease_expires_at', { withTimezone: true }),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
});

export const epicRunEventRowSchema = createSelectSchema(epicRunEvents, {
  created_at: z.coerce.string(),
});
export type EpicRunEventRow = Omit<InferSelectModel<typeof epicRunEvents>, 'created_at'> & {
  created_at: string;
};

export const epicRunLeaseRowSchema = createSelectSchema(epicRunLease, {
  lease_expires_at: z.coerce.string().nullable(),
  updated_at: z.coerce.string(),
});
export type EpicRunLeaseRow = Omit<
  InferSelectModel<typeof epicRunLease>,
  'lease_expires_at' | 'updated_at'
> & {
  lease_expires_at: string | null;
  updated_at: string;
};

export const epicRunSummarySchema = z.object({
  active_runs: z.number(),
  total_events: z.number(),
  recent_event_types: z.array(z.string()),
});
export type EpicRunSummary = z.infer<typeof epicRunSummarySchema>;

export const epicRunPayloadSchema = z.object({
  events: z.array(epicRunEventRowSchema),
  leases: z.array(epicRunLeaseRowSchema),
  summary: epicRunSummarySchema,
});
export type EpicRunPayload = z.infer<typeof epicRunPayloadSchema>;

// ============================================================================
// PR Watch State
// ============================================================================

export const prWatchState = pgTable('pr_watch_state', {
  correlation_id: text('correlation_id').primaryKey(),
  pr_number: integer('pr_number'),
  repo: text('repo'),
  state: text('state').notNull(),
  checks_status: text('checks_status'),
  review_status: text('review_status'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
});

export const prWatchRowSchema = createSelectSchema(prWatchState, {
  created_at: z.coerce.string(),
});
export type PrWatchRow = Omit<InferSelectModel<typeof prWatchState>, 'created_at'> & {
  created_at: string;
};

export const prWatchSummarySchema = z.object({
  total: z.number(),
  open: z.number(),
  merged: z.number(),
  closed: z.number(),
  checks_passing: z.number(),
});
export type PrWatchSummary = z.infer<typeof prWatchSummarySchema>;

export const prWatchPayloadSchema = z.object({
  recent: z.array(prWatchRowSchema),
  summary: prWatchSummarySchema,
});
export type PrWatchPayload = z.infer<typeof prWatchPayloadSchema>;

// ============================================================================
// Pipeline Budget State
// ============================================================================

export const pipelineBudgetState = pgTable('pipeline_budget_state', {
  correlation_id: text('correlation_id').primaryKey(),
  pipeline_id: text('pipeline_id').notNull(),
  budget_type: text('budget_type').notNull(),
  cap_value: integer('cap_value'),
  current_value: integer('current_value'),
  cap_hit: boolean('cap_hit').notNull(),
  repo: text('repo'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
});

export const pipelineBudgetRowSchema = createSelectSchema(pipelineBudgetState, {
  created_at: z.coerce.string(),
});
export type PipelineBudgetRow = Omit<InferSelectModel<typeof pipelineBudgetState>, 'created_at'> & {
  created_at: string;
};

export const pipelineBudgetSummarySchema = z.object({
  total_cap_hits: z.number(),
  affected_pipelines: z.number(),
  token_cap_hits: z.number(),
  cost_cap_hits: z.number(),
});
export type PipelineBudgetSummary = z.infer<typeof pipelineBudgetSummarySchema>;

export const pipelineBudgetPayloadSchema = z.object({
  recent: z.array(pipelineBudgetRowSchema),
  summary: pipelineBudgetSummarySchema,
});
export type PipelineBudgetPayload = z.infer<typeof pipelineBudgetPayloadSchema>;

// ============================================================================
// Debug Escalation Counts
// ============================================================================

export const debugEscalationCounts = pgTable('debug_escalation_counts', {
  correlation_id: text('correlation_id').primaryKey(),
  session_id: text('session_id'),
  agent_name: text('agent_name').notNull(),
  escalation_count: integer('escalation_count').notNull(),
  tripped: boolean('tripped').notNull(),
  repo: text('repo'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
});

export const debugEscalationRowSchema = createSelectSchema(debugEscalationCounts, {
  created_at: z.coerce.string(),
});
export type DebugEscalationRow = Omit<
  InferSelectModel<typeof debugEscalationCounts>,
  'created_at'
> & {
  created_at: string;
};

export const debugEscalationSummarySchema = z.object({
  total_trips: z.number(),
  affected_agents: z.number(),
  affected_sessions: z.number(),
  top_agent: z.string().nullable(),
});
export type DebugEscalationSummary = z.infer<typeof debugEscalationSummarySchema>;

export const debugEscalationPayloadSchema = z.object({
  recent: z.array(debugEscalationRowSchema),
  summary: debugEscalationSummarySchema,
});
export type DebugEscalationPayload = z.infer<typeof debugEscalationPayloadSchema>;

// ============================================================================
// DoD Verification Runs (OMN-5199 / OMN-5200)
// Single schema ownership: pgTable lives in intelligence-schema.ts (OMN-5430).
// Zod schemas here use z.object() to match raw SQL snake_case column names
// returned by the projection's raw sql`` queries.
// ============================================================================

export { dodVerifyRuns, dodGuardEvents } from './intelligence-schema';

export const dodVerifyRunRowSchema = z.object({
  id: z.string().uuid(),
  ticket_id: z.string(),
  run_id: z.string(),
  session_id: z.string().nullable(),
  correlation_id: z.string().nullable(),
  total_checks: z.number(),
  passed_checks: z.number(),
  failed_checks: z.number(),
  skipped_checks: z.number(),
  overall_pass: z.boolean(),
  policy_mode: z.string(),
  evidence_items: z.array(z.unknown()),
  event_timestamp: z.coerce.string(),
  ingested_at: z.coerce.string(),
});
export type DodVerifyRunRow = z.infer<typeof dodVerifyRunRowSchema>;

// ============================================================================
// DoD Guard Events (OMN-5199 / OMN-5200)
// Single schema ownership: pgTable lives in intelligence-schema.ts (OMN-5430).
// ============================================================================

export const dodGuardEventRowSchema = z.object({
  id: z.string().uuid(),
  ticket_id: z.string(),
  session_id: z.string().nullable(),
  guard_outcome: z.string(),
  policy_mode: z.string(),
  receipt_age_seconds: z.coerce.number().nullable(),
  receipt_pass: z.boolean().nullable(),
  event_timestamp: z.coerce.string(),
  ingested_at: z.coerce.string(),
});
export type DodGuardEventRow = z.infer<typeof dodGuardEventRowSchema>;

// ============================================================================
// DoD Dashboard Payload (OMN-5200)
// ============================================================================

export const dodStatsSchema = z.object({
  total_runs: z.number(),
  pass_rate_7d: z.number(),
  guard_blocks_7d: z.number(),
  tickets_with_evidence: z.number(),
});
export type DodStats = z.infer<typeof dodStatsSchema>;

export const dodTrendPointSchema = z.object({
  date: z.string(),
  pass_rate: z.number(),
  total: z.number(),
});
export type DodTrendPoint = z.infer<typeof dodTrendPointSchema>;

export const dodPayloadSchema = z.object({
  stats: dodStatsSchema,
  verify_runs: z.array(dodVerifyRunRowSchema),
  guard_events: z.array(dodGuardEventRowSchema),
  trends: z.array(dodTrendPointSchema),
});
export type DodPayload = z.infer<typeof dodPayloadSchema>;

// ============================================================================
// Hostile Reviewer Runs (OMN-5864)
// ============================================================================

export const hostileReviewerRuns = pgTable('hostile_reviewer_runs', {
  event_id: text('event_id').primaryKey(),
  correlation_id: text('correlation_id').notNull(),
  mode: text('mode').notNull(),
  target: text('target').notNull(),
  verdict: text('verdict').notNull(),
  total_findings: integer('total_findings').notNull(),
  critical_count: integer('critical_count').notNull(),
  major_count: integer('major_count').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
});

export const hostileReviewerRunRowSchema = createSelectSchema(hostileReviewerRuns, {
  created_at: z.coerce.string(),
});
export type HostileReviewerRunRow = Omit<
  InferSelectModel<typeof hostileReviewerRuns>,
  'created_at'
> & {
  created_at: string;
};

export const hostileReviewerSummarySchema = z.object({
  total_runs: z.number(),
  verdict_counts: z.record(z.string(), z.number()),
});
export type HostileReviewerSummary = z.infer<typeof hostileReviewerSummarySchema>;

export const hostileReviewerPayloadSchema = z.object({
  recent: z.array(hostileReviewerRunRowSchema),
  summary: hostileReviewerSummarySchema,
});
export type HostileReviewerPayload = z.infer<typeof hostileReviewerPayloadSchema>;
