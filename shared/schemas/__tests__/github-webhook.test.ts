/**
 * Tests for GitHub webhook payload Zod schemas.
 * TDD: Written before implementation [OMN-6719].
 */

import { describe, it, expect } from 'vitest';
import {
  GitHubPrMergedPayloadSchema,
  GitHubPushToMainPayloadSchema,
  GitHubCheckSuiteCompletedPayloadSchema,
  GitHubWebhookPayloadSchema,
  type GitHubPrMergedPayload,
  type GitHubPushToMainPayload,
  type GitHubCheckSuiteCompletedPayload,
} from '../github-webhook';

// ============================================================================
// GitHubPrMergedPayloadSchema
// ============================================================================

describe('GitHubPrMergedPayloadSchema', () => {
  const validPayload: GitHubPrMergedPayload = {
    kind: 'pr_merged',
    repo: 'OmniNode-ai/omnidash',
    pr_number: 42,
    pr_title: 'feat: add webhook support',
    pr_branch: 'feature/webhooks',
    base_branch: 'main',
    merge_sha: 'abc123def456',
    merged_by: 'jonahgabriel',
    merged_at: '2026-04-01T12:00:00Z',
  };

  it('should parse a valid PR merged payload', () => {
    const result = GitHubPrMergedPayloadSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe('pr_merged');
      expect(result.data.repo).toBe('OmniNode-ai/omnidash');
      expect(result.data.pr_number).toBe(42);
    }
  });

  it('should reject missing required fields', () => {
    const { repo, ...missing } = validPayload;
    const result = GitHubPrMergedPayloadSchema.safeParse(missing);
    expect(result.success).toBe(false);
  });

  it('should reject wrong kind discriminator', () => {
    const result = GitHubPrMergedPayloadSchema.safeParse({
      ...validPayload,
      kind: 'push_to_main',
    });
    expect(result.success).toBe(false);
  });

  it('should reject non-number pr_number', () => {
    const result = GitHubPrMergedPayloadSchema.safeParse({
      ...validPayload,
      pr_number: 'not-a-number',
    });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// GitHubPushToMainPayloadSchema
// ============================================================================

describe('GitHubPushToMainPayloadSchema', () => {
  const validPayload: GitHubPushToMainPayload = {
    kind: 'push_to_main',
    repo: 'OmniNode-ai/omnidash',
    ref: 'refs/heads/main',
    before_sha: 'aaa111',
    after_sha: 'bbb222',
    pusher: 'jonahgabriel',
    commits: [
      {
        sha: 'bbb222',
        message: 'feat: add webhook support',
        author: 'jonahgabriel',
      },
    ],
  };

  it('should parse a valid push-to-main payload', () => {
    const result = GitHubPushToMainPayloadSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe('push_to_main');
      expect(result.data.commits).toHaveLength(1);
    }
  });

  it('should accept empty commits array', () => {
    const result = GitHubPushToMainPayloadSchema.safeParse({
      ...validPayload,
      commits: [],
    });
    expect(result.success).toBe(true);
  });

  it('should reject missing ref', () => {
    const { ref, ...missing } = validPayload;
    const result = GitHubPushToMainPayloadSchema.safeParse(missing);
    expect(result.success).toBe(false);
  });

  it('should reject wrong kind discriminator', () => {
    const result = GitHubPushToMainPayloadSchema.safeParse({
      ...validPayload,
      kind: 'pr_merged',
    });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// GitHubCheckSuiteCompletedPayloadSchema
// ============================================================================

describe('GitHubCheckSuiteCompletedPayloadSchema', () => {
  const validPayload: GitHubCheckSuiteCompletedPayload = {
    kind: 'check_suite_completed',
    repo: 'OmniNode-ai/omnidash',
    head_sha: 'ccc333',
    head_branch: 'main',
    conclusion: 'success',
    check_suite_id: 12345,
    app_name: 'GitHub Actions',
  };

  it('should parse a valid check suite completed payload', () => {
    const result = GitHubCheckSuiteCompletedPayloadSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe('check_suite_completed');
      expect(result.data.conclusion).toBe('success');
    }
  });

  it('should accept failure conclusion', () => {
    const result = GitHubCheckSuiteCompletedPayloadSchema.safeParse({
      ...validPayload,
      conclusion: 'failure',
    });
    expect(result.success).toBe(true);
  });

  it('should reject missing check_suite_id', () => {
    const { check_suite_id, ...missing } = validPayload;
    const result = GitHubCheckSuiteCompletedPayloadSchema.safeParse(missing);
    expect(result.success).toBe(false);
  });

  it('should reject wrong kind discriminator', () => {
    const result = GitHubCheckSuiteCompletedPayloadSchema.safeParse({
      ...validPayload,
      kind: 'pr_merged',
    });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// GitHubWebhookPayloadSchema (discriminated union)
// ============================================================================

describe('GitHubWebhookPayloadSchema', () => {
  it('should parse pr_merged variant', () => {
    const result = GitHubWebhookPayloadSchema.safeParse({
      kind: 'pr_merged',
      repo: 'OmniNode-ai/omnidash',
      pr_number: 42,
      pr_title: 'feat: webhooks',
      pr_branch: 'feature/webhooks',
      base_branch: 'main',
      merge_sha: 'abc123',
      merged_by: 'jonahgabriel',
      merged_at: '2026-04-01T12:00:00Z',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe('pr_merged');
    }
  });

  it('should parse push_to_main variant', () => {
    const result = GitHubWebhookPayloadSchema.safeParse({
      kind: 'push_to_main',
      repo: 'OmniNode-ai/omnidash',
      ref: 'refs/heads/main',
      before_sha: 'aaa',
      after_sha: 'bbb',
      pusher: 'jonahgabriel',
      commits: [],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe('push_to_main');
    }
  });

  it('should parse check_suite_completed variant', () => {
    const result = GitHubWebhookPayloadSchema.safeParse({
      kind: 'check_suite_completed',
      repo: 'OmniNode-ai/omnidash',
      head_sha: 'ccc',
      head_branch: 'main',
      conclusion: 'success',
      check_suite_id: 123,
      app_name: 'GitHub Actions',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe('check_suite_completed');
    }
  });

  it('should reject unknown kind', () => {
    const result = GitHubWebhookPayloadSchema.safeParse({
      kind: 'unknown_event',
      repo: 'OmniNode-ai/omnidash',
    });
    expect(result.success).toBe(false);
  });
});
