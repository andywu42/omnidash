/**
 * Topic Parity Contract Test (OMN-6978)
 *
 * Validates internal omnidash consistency between:
 *   - topics.yaml (read-model subscription manifest)
 *   - shared/topics.ts (TypeScript topic constants)
 *
 * Catches three classes of mismatch:
 *   1. Topic in topics.yaml with no matching constant in topics.ts
 *   2. Topic constant in topics.ts not present in topics.yaml (for consumed topics)
 *   3. Name drift between similar topics (e.g. version suffix differences)
 *
 * This test reads files from disk — no Kafka connection needed.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Parse topics.yaml and return the list of read_model_topics and monitored_topics.
 */
function loadTopicsYaml(): {
  readModelTopics: string[];
  monitoredTopics: string[];
} {
  const yamlPath = path.join(PROJECT_ROOT, 'topics.yaml');
  const raw = fs.readFileSync(yamlPath, 'utf-8');
  const parsed = yaml.load(raw) as {
    read_model_topics: Array<{ topic: string; handler?: string }>;
    monitored_topics?: Array<{ topic: string }>;
  };

  return {
    readModelTopics: parsed.read_model_topics.map((e) => e.topic),
    monitoredTopics: (parsed.monitored_topics ?? []).map((e) => e.topic),
  };
}

/**
 * Parse shared/topics.ts and extract all exported SUFFIX_* and TOPIC_* string values.
 * Uses regex to find `export const SUFFIX_FOO = 'value'` and `export const TOPIC_FOO = 'value'`.
 */
function loadTopicConstants(): Map<string, string> {
  const tsPath = path.join(PROJECT_ROOT, 'shared', 'topics.ts');
  const source = fs.readFileSync(tsPath, 'utf-8');

  const constants = new Map<string, string>();

  // Match single-line declarations: export const SUFFIX_FOO = 'value';
  const singleLineRegex =
    /export\s+const\s+((?:SUFFIX|TOPIC)_[A-Z0-9_]+)\s*=\s*['"]([^'"]+)['"]/g;

  let match: RegExpExecArray | null;
  while ((match = singleLineRegex.exec(source)) !== null) {
    constants.set(match[1], match[2]);
  }

  // Also match multi-line declarations where the value is on the next line
  const multiLineRegex =
    /export\s+const\s+((?:SUFFIX|TOPIC)_[A-Z0-9_]+)\s*=\s*\n\s*['"]([^'"]+)['"]/g;

  while ((match = multiLineRegex.exec(source)) !== null) {
    if (!constants.has(match[1])) {
      constants.set(match[1], match[2]);
    }
  }

  return constants;
}

/**
 * Extract the "base name" of a topic for drift detection.
 * Strips the version suffix (e.g. ".v1") to compare topic stems.
 */
function topicStem(topic: string): string {
  return topic.replace(/\.v\d+$/, '');
}

/**
 * Compute Levenshtein distance between two strings (for near-match detection).
 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }

  return dp[m][n];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Topic Parity Contract (OMN-6978)', () => {
  const { readModelTopics, monitoredTopics } = loadTopicsYaml();
  const topicConstants = loadTopicConstants();
  const allConstantValues = new Set(topicConstants.values());

  // -------------------------------------------------------------------------
  // 1. Every topic in topics.yaml read_model_topics has a constant in topics.ts
  // -------------------------------------------------------------------------
  describe('topics.yaml -> topics.ts coverage', () => {
    it('every read_model_topic in topics.yaml should have a matching constant in topics.ts', () => {
      const missing: string[] = [];

      for (const topic of readModelTopics) {
        if (!allConstantValues.has(topic)) {
          missing.push(topic);
        }
      }

      if (missing.length > 0) {
        const details = missing
          .map((t) => `  Topic "${t}" is subscribed in topics.yaml but has no constant in topics.ts`)
          .join('\n');
        expect.fail(
          `${missing.length} topic(s) in topics.yaml have no matching constant in topics.ts:\n${details}`
        );
      }
    });

    it('should have at least one read_model_topic defined', () => {
      expect(readModelTopics.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Topics.ts constants from subscribed producers not in topics.yaml
  // -------------------------------------------------------------------------
  describe('topics.ts constants referenced by read-model topics', () => {
    it('every topic constant value that IS in topics.yaml should remain there (no accidental removal)', () => {
      const yamlTopicSet = new Set(readModelTopics);
      const monitoredSet = new Set(monitoredTopics);

      // Collect producers we subscribe to
      const subscribedProducers = new Set<string>();
      for (const topic of readModelTopics) {
        const parts = topic.split('.');
        if (parts.length >= 3) {
          subscribedProducers.add(parts[2]);
        }
      }

      const tsSource = fs.readFileSync(
        path.join(PROJECT_ROOT, 'shared', 'topics.ts'),
        'utf-8'
      );

      const orphanedConstants: string[] = [];

      for (const [constName, value] of topicConstants) {
        // Skip non-ONEX topics
        if (!value.startsWith('onex.')) continue;

        // Skip deprecated constants
        const constIndex = tsSource.indexOf(constName);
        if (constIndex > 0) {
          const preceding = tsSource.slice(Math.max(0, constIndex - 200), constIndex);
          if (preceding.includes('@deprecated')) continue;
        }

        const valueParts = value.split('.');
        const producer = valueParts.length >= 3 ? valueParts[2] : null;

        // Only flag evt topics from producers we already subscribe to
        if (
          producer &&
          subscribedProducers.has(producer) &&
          !yamlTopicSet.has(value) &&
          !monitoredSet.has(value)
        ) {
          // Skip cmd/intent/snapshot topics (not consumed by read model)
          if (valueParts[1] === 'cmd') continue;
          if (valueParts[1] === 'intent' || valueParts[1] === 'snapshot') continue;

          orphanedConstants.push(
            `  Constant ${constName} = "${value}" has no entry in topics.yaml`
          );
        }
      }

      if (orphanedConstants.length > 0) {
        // Informational warning — not all constants need to be in topics.yaml
        console.warn(
          `[topic-parity] ${orphanedConstants.length} topic constant(s) from subscribed producers not in topics.yaml:\n${orphanedConstants.join('\n')}`
        );
      }
    });
  });

  // -------------------------------------------------------------------------
  // 3. topics.yaml internal consistency
  // -------------------------------------------------------------------------
  describe('topics.yaml internal consistency', () => {
    it('should have no duplicate topics in read_model_topics', () => {
      const seen = new Set<string>();
      const duplicates: string[] = [];

      for (const topic of readModelTopics) {
        if (seen.has(topic)) {
          duplicates.push(topic);
        }
        seen.add(topic);
      }

      if (duplicates.length > 0) {
        expect.fail(
          `Duplicate topics in topics.yaml read_model_topics:\n${duplicates.map((t) => `  ${t}`).join('\n')}`
        );
      }
    });

    it('all read_model_topics should follow ONEX naming convention', () => {
      const nonConformant: string[] = [];
      const onexPattern = /^onex\.(evt|cmd|intent|snapshot|dlq)\.[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\.v\d+$/;

      for (const topic of readModelTopics) {
        if (!onexPattern.test(topic)) {
          nonConformant.push(topic);
        }
      }

      if (nonConformant.length > 0) {
        expect.fail(
          `Topics not matching ONEX naming convention (onex.<kind>.<producer>.<event-name>.v<N>):\n${nonConformant.map((t) => `  ${t}`).join('\n')}`
        );
      }
    });

    it('every read_model_topic entry should have a handler defined', () => {
      const yamlPath = path.join(PROJECT_ROOT, 'topics.yaml');
      const raw = fs.readFileSync(yamlPath, 'utf-8');
      const parsed = yaml.load(raw) as {
        read_model_topics: Array<{ topic: string; handler?: string }>;
      };

      const noHandler: string[] = [];
      for (const entry of parsed.read_model_topics) {
        if (!entry.handler) {
          noHandler.push(entry.topic);
        }
      }

      if (noHandler.length > 0) {
        expect.fail(
          `Topics in topics.yaml missing a handler:\n${noHandler.map((t) => `  ${t}`).join('\n')}`
        );
      }
    });
  });

  // -------------------------------------------------------------------------
  // 4. topics.ts internal consistency
  // -------------------------------------------------------------------------
  describe('topics.ts internal consistency', () => {
    it('should have no duplicate constant values in topics.ts', () => {
      const valueToConstants = new Map<string, string[]>();

      for (const [constName, value] of topicConstants) {
        const existing = valueToConstants.get(value) ?? [];
        existing.push(constName);
        valueToConstants.set(value, existing);
      }

      const duplicates: string[] = [];
      for (const [value, names] of valueToConstants) {
        if (names.length > 1) {
          // Allow known aliases (TOPIC_ and SUFFIX_ for the same value)
          const hasBothPrefixes =
            names.some((n) => n.startsWith('SUFFIX_')) &&
            names.some((n) => n.startsWith('TOPIC_'));
          if (hasBothPrefixes && names.length === 2) continue;

          duplicates.push(`  "${value}" is defined by: ${names.join(', ')}`);
        }
      }

      if (duplicates.length > 0) {
        expect.fail(
          `Duplicate topic values in topics.ts (not counting SUFFIX_/TOPIC_ aliases):\n${duplicates.join('\n')}`
        );
      }
    });

    it('should have at least one topic constant defined', () => {
      expect(topicConstants.size).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Name drift detection
  // -------------------------------------------------------------------------
  describe('name drift detection', () => {
    it('should not have near-miss topics between topics.yaml and topics.ts', () => {
      const yamlTopicSet = new Set(readModelTopics);
      const driftWarnings: string[] = [];

      // For each yaml topic not in constants, check for near-matches
      for (const yamlTopic of readModelTopics) {
        if (allConstantValues.has(yamlTopic)) continue;

        let closestValue = '';
        let closestName = '';
        let closestDist = Infinity;

        for (const [constName, constValue] of topicConstants) {
          const dist = levenshtein(topicStem(yamlTopic), topicStem(constValue));
          if (dist < closestDist && dist > 0) {
            closestDist = dist;
            closestValue = constValue;
            closestName = constName;
          }
        }

        if (closestDist > 0 && closestDist <= 3) {
          // Skip if the closest constant value already has an exact match in yaml
          // (meaning both topics are intentionally distinct)
          if (yamlTopicSet.has(closestValue)) continue;

          driftWarnings.push(
            `  topics.yaml: "${yamlTopic}" ~ topics.ts ${closestName}: "${closestValue}" (edit distance: ${closestDist})`
          );
        }
      }

      // Reverse direction: only flag constants whose near-match yaml topic
      // does NOT itself have an exact match in the constants. This prevents
      // false positives like pattern-scored vs pattern-stored where both are
      // legitimately different topics.
      for (const [constName, constValue] of topicConstants) {
        if (!constValue.startsWith('onex.')) continue;
        if (yamlTopicSet.has(constValue)) continue;

        let closestYaml = '';
        let closestDist = Infinity;

        for (const yamlTopic of readModelTopics) {
          const dist = levenshtein(topicStem(constValue), topicStem(yamlTopic));
          if (dist < closestDist && dist > 0) {
            closestDist = dist;
            closestYaml = yamlTopic;
          }
        }

        if (closestDist > 0 && closestDist <= 3) {
          // Skip if the closest yaml topic already has an exact match in constants
          // (meaning both topics are intentionally distinct)
          if (allConstantValues.has(closestYaml)) continue;

          const alreadyFlagged = driftWarnings.some(
            (w) => w.includes(constValue) && w.includes(closestYaml)
          );
          if (!alreadyFlagged) {
            driftWarnings.push(
              `  topics.ts ${constName}: "${constValue}" ~ topics.yaml: "${closestYaml}" (edit distance: ${closestDist})`
            );
          }
        }
      }

      if (driftWarnings.length > 0) {
        expect.fail(
          `Possible topic name drift detected (small edit distance between yaml and ts):\n${driftWarnings.join('\n')}`
        );
      }
    });

    it('should not have version mismatches between topics.yaml and topics.ts', () => {
      const yamlStems = new Map<string, string>();
      for (const topic of readModelTopics) {
        yamlStems.set(topicStem(topic), topic);
      }

      const constStems = new Map<string, { name: string; value: string }>();
      for (const [name, value] of topicConstants) {
        if (value.startsWith('onex.')) {
          constStems.set(topicStem(value), { name, value });
        }
      }

      const versionMismatches: string[] = [];

      for (const [stem, yamlTopic] of yamlStems) {
        const constEntry = constStems.get(stem);
        if (constEntry && constEntry.value !== yamlTopic) {
          versionMismatches.push(
            `  Stem "${stem}": topics.yaml has "${yamlTopic}" but topics.ts ${constEntry.name} has "${constEntry.value}"`
          );
        }
      }

      if (versionMismatches.length > 0) {
        expect.fail(
          `Version mismatches detected (same topic stem, different version):\n${versionMismatches.join('\n')}`
        );
      }
    });
  });
});
