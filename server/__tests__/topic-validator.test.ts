/**
 * Tests for the ONEX topic format validator (TypeScript gate).
 *
 * Mirrors the Python test suite in omnibase_infra to ensure cross-runtime parity.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  validateOnexTopicFormat,
  enforceTopicFormat,
  getEnforcementMode,
} from '../topic-validator';
import {
  SUFFIX_GITHUB_PR_MERGED,
  SUFFIX_GITHUB_PUSH_TO_MAIN,
  SUFFIX_GITHUB_CHECK_SUITE_COMPLETED,
} from '../../shared/topics';

// ============================================================================
// validateOnexTopicFormat
// ============================================================================

describe('validateOnexTopicFormat', () => {
  describe('valid canonical ONEX topics', () => {
    const validTopics = [
      'onex.evt.omniclaude.session-started.v1',
      'onex.cmd.omniintelligence.code-analysis.v1',
      'onex.intent.omnimemory.crawl-requested.v1',
      'onex.dlq.omniclaude.agent-actions.v1',
      'onex.evt.platform.node-heartbeat.v1',
      'onex.evt.omniclaude.transformation.completed.v1',
      'onex.evt.platform.node-registration.v12',
    ];

    it.each(validTopics)('should accept %s as valid', (topic) => {
      const [result, reason] = validateOnexTopicFormat(topic);
      expect(result).toBe('valid');
      expect(reason).toBe('');
    });
  });

  describe('valid legacy DLQ topics', () => {
    const legacyDlqTopics = ['onex.dlq.intelligence.v1', 'local.dlq.intents.v1'];

    it.each(legacyDlqTopics)('should accept %s as valid_legacy_dlq', (topic) => {
      const [result, reason] = validateOnexTopicFormat(topic);
      expect(result).toBe('valid_legacy_dlq');
      expect(reason).toBe('legacy DLQ format');
    });
  });

  describe('invalid topics', () => {
    const invalidTopics = [
      'dev.onex.evt.omniclaude.session-started.v1', // env prefix
      'onex.evt.omniclaude.session-started', // missing version
      'agent-actions', // legacy flat name
      'staging.onex.cmd.omniintelligence.code-analysis.v1', // env prefix
      '', // empty
      'onex.evt', // too few segments
      'onex.unknown.omniclaude.session-started.v1', // invalid kind
      'onex.evt.omniclaude.session-started.v0', // v0 not allowed
    ];

    it.each(invalidTopics)('should reject %s as invalid', (topic) => {
      const [result, reason] = validateOnexTopicFormat(topic);
      expect(result).toBe('invalid');
      expect(reason).not.toBe('');
    });
  });

  describe('GitHub webhook topic constants (OMN-6720)', () => {
    const githubTopics = [
      SUFFIX_GITHUB_PR_MERGED,
      SUFFIX_GITHUB_PUSH_TO_MAIN,
      SUFFIX_GITHUB_CHECK_SUITE_COMPLETED,
    ];

    it.each(githubTopics)('should accept %s as valid', (topic) => {
      const [result, reason] = validateOnexTopicFormat(topic);
      expect(result).toBe('valid');
      expect(reason).toBe('');
    });
  });

  describe('Kafka internal topics', () => {
    const internalTopics = ['__consumer_offsets', '__transaction_state'];

    it.each(internalTopics)('should skip %s as internal', (topic) => {
      const [result, reason] = validateOnexTopicFormat(topic);
      expect(result).toBe('skipped_internal');
      expect(reason).toBe('');
    });
  });
});

// ============================================================================
// getEnforcementMode
// ============================================================================

describe('getEnforcementMode', () => {
  const originalEnv = process.env.ONEX_TOPIC_ENFORCEMENT_MODE;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.ONEX_TOPIC_ENFORCEMENT_MODE = originalEnv;
    } else {
      delete process.env.ONEX_TOPIC_ENFORCEMENT_MODE;
    }
  });

  it('should default to warn when env var is not set', () => {
    delete process.env.ONEX_TOPIC_ENFORCEMENT_MODE;
    expect(getEnforcementMode()).toBe('warn');
  });

  it('should return reject when set to reject', () => {
    process.env.ONEX_TOPIC_ENFORCEMENT_MODE = 'reject';
    expect(getEnforcementMode()).toBe('reject');
  });

  it('should return off when set to off', () => {
    process.env.ONEX_TOPIC_ENFORCEMENT_MODE = 'off';
    expect(getEnforcementMode()).toBe('off');
  });

  it('should default to warn for invalid values', () => {
    process.env.ONEX_TOPIC_ENFORCEMENT_MODE = 'invalid';
    expect(getEnforcementMode()).toBe('warn');
  });
});

// ============================================================================
// enforceTopicFormat
// ============================================================================

describe('enforceTopicFormat', () => {
  const originalEnv = process.env.ONEX_TOPIC_ENFORCEMENT_MODE;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.ONEX_TOPIC_ENFORCEMENT_MODE = originalEnv;
    } else {
      delete process.env.ONEX_TOPIC_ENFORCEMENT_MODE;
    }
  });

  it('should not throw for valid topics in warn mode', () => {
    process.env.ONEX_TOPIC_ENFORCEMENT_MODE = 'warn';
    expect(() => enforceTopicFormat('onex.evt.omniclaude.session-started.v1')).not.toThrow();
  });

  it('should log warning for invalid topics in warn mode', () => {
    process.env.ONEX_TOPIC_ENFORCEMENT_MODE = 'warn';
    const mockLogger = vi.fn();
    enforceTopicFormat('agent-actions', mockLogger);
    expect(mockLogger).toHaveBeenCalledOnce();
    expect(mockLogger).toHaveBeenCalledWith(expect.stringContaining('[ONEX Topic Gate]'));
  });

  it('should throw for invalid topics in reject mode', () => {
    process.env.ONEX_TOPIC_ENFORCEMENT_MODE = 'reject';
    expect(() => enforceTopicFormat('agent-actions')).toThrow('[ONEX Topic Gate]');
  });

  it('should not throw for valid topics in reject mode', () => {
    process.env.ONEX_TOPIC_ENFORCEMENT_MODE = 'reject';
    expect(() => enforceTopicFormat('onex.evt.omniclaude.session-started.v1')).not.toThrow();
  });

  it('should skip validation entirely in off mode', () => {
    process.env.ONEX_TOPIC_ENFORCEMENT_MODE = 'off';
    const mockLogger = vi.fn();
    enforceTopicFormat('agent-actions', mockLogger);
    expect(mockLogger).not.toHaveBeenCalled();
  });

  it('should not throw for Kafka internal topics', () => {
    process.env.ONEX_TOPIC_ENFORCEMENT_MODE = 'reject';
    expect(() => enforceTopicFormat('__consumer_offsets')).not.toThrow();
  });
});
