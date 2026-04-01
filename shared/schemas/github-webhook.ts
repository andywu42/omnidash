/**
 * Zod schemas for normalized GitHub webhook event payloads.
 *
 * These are ONEX-side payloads (not raw GitHub payloads). The webhook route
 * handler normalizes raw GitHub payloads into these shapes at the boundary.
 *
 * Each schema carries a `kind` discriminator for use in the discriminated
 * union `GitHubWebhookPayloadSchema`.
 *
 * OMN-6719
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Individual payload schemas
// ---------------------------------------------------------------------------

/** Normalized PR merged event payload. */
export const GitHubPrMergedPayloadSchema = z.object({
  kind: z.literal('pr_merged'),
  repo: z.string(),
  pr_number: z.number().int(),
  pr_title: z.string(),
  pr_branch: z.string(),
  base_branch: z.string(),
  merge_sha: z.string(),
  merged_by: z.string(),
  merged_at: z.string(),
});

/** Normalized push-to-main event payload. */
export const GitHubPushToMainPayloadSchema = z.object({
  kind: z.literal('push_to_main'),
  repo: z.string(),
  ref: z.string(),
  before_sha: z.string(),
  after_sha: z.string(),
  pusher: z.string(),
  commits: z.array(
    z.object({
      sha: z.string(),
      message: z.string(),
      author: z.string(),
    })
  ),
});

/** Normalized check suite completed event payload. */
export const GitHubCheckSuiteCompletedPayloadSchema = z.object({
  kind: z.literal('check_suite_completed'),
  repo: z.string(),
  head_sha: z.string(),
  head_branch: z.string(),
  conclusion: z.string(),
  check_suite_id: z.number().int(),
  app_name: z.string(),
});

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

/** Discriminated union of all GitHub webhook payloads, keyed by `kind`. */
export const GitHubWebhookPayloadSchema = z.discriminatedUnion('kind', [
  GitHubPrMergedPayloadSchema,
  GitHubPushToMainPayloadSchema,
  GitHubCheckSuiteCompletedPayloadSchema,
]);

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type GitHubPrMergedPayload = z.infer<typeof GitHubPrMergedPayloadSchema>;
export type GitHubPushToMainPayload = z.infer<typeof GitHubPushToMainPayloadSchema>;
export type GitHubCheckSuiteCompletedPayload = z.infer<
  typeof GitHubCheckSuiteCompletedPayloadSchema
>;
export type GitHubWebhookPayload = z.infer<typeof GitHubWebhookPayloadSchema>;
