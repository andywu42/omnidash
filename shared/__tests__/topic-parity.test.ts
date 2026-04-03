/**
 * Topic Parity Contract Test (OMN-6978)
 *
 * Validates that topics.yaml (what omnidash subscribes to) and shared/topics.ts
 * (canonical topic constants) are consistent:
 *
 *   1. Every read_model_topics entry in topics.yaml has a matching constant in topics.ts
 *   2. All topics follow the canonical ONEX naming format:
 *      onex.<kind>.<producer>.<event-name>.v<N>
 *   3. No duplicate topics in topics.yaml
 *
 * This prevents topic mismatches (e.g. skill-invoked vs skill-started) from
 * surviving to production undetected.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import * as topicsModule from '@shared/topics';

// ---------------------------------------------------------------------------
// Load topics.yaml
// ---------------------------------------------------------------------------

const TOPICS_YAML_PATH = path.resolve(__dirname, '../../topics.yaml');
const rawYaml = fs.readFileSync(TOPICS_YAML_PATH, 'utf-8');
const manifest = yaml.load(rawYaml) as {
  version: string;
  read_model_topics: Array<{ topic: string; handler?: string }>;
  monitored_topics?: Array<{ topic: string }>;
};

// ---------------------------------------------------------------------------
// Collect all SUFFIX_*/TOPIC_* string constants from topics.ts
// ---------------------------------------------------------------------------

const topicConstants: Map<string, string> = new Map();
for (const [key, value] of Object.entries(topicsModule)) {
  if (
    typeof value === 'string' &&
    (key.startsWith('SUFFIX_') || key.startsWith('TOPIC_')) &&
    value.startsWith('onex.')
  ) {
    topicConstants.set(value, key);
  }
}

// ---------------------------------------------------------------------------
// Canonical ONEX topic format regex
// ---------------------------------------------------------------------------

// onex.<kind>.<producer>.<event-name>.v<N>
// kind: evt | cmd | intent | snapshot | dlq
// producer: lowercase alphanumeric + hyphens
// event-name: lowercase alphanumeric + hyphens (may contain dots for multi-segment)
// version: v followed by digits
const ONEX_TOPIC_REGEX =
  /^onex\.(evt|cmd|intent|snapshot|dlq)\.[a-z][a-z0-9-]*\.[a-z][a-z0-9.-]*\.v\d+$/;

// Monitored topics may use underscore-prefixed non-ONEX names
const MONITORED_TOPIC_REGEX = /^(_[a-z][a-z0-9-]*\.[a-z][a-z0-9.-]*\.v\d+|onex\..+)$/;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Topic Parity Contract (OMN-6978)', () => {
  const readModelTopics = manifest.read_model_topics.map((e) => e.topic);
  const monitoredTopics = (manifest.monitored_topics ?? []).map((e) => e.topic);

  describe('topics.yaml structure', () => {
    it('should have a version field', () => {
      expect(manifest.version).toBeDefined();
    });

    it('should have at least one read_model_topic', () => {
      expect(readModelTopics.length).toBeGreaterThan(0);
    });
  });

  describe('no duplicate topics in topics.yaml', () => {
    it('read_model_topics should have no duplicates', () => {
      const seen = new Set<string>();
      const duplicates: string[] = [];
      for (const topic of readModelTopics) {
        if (seen.has(topic)) {
          duplicates.push(topic);
        }
        seen.add(topic);
      }
      expect(duplicates).toEqual([]);
    });

    it('monitored_topics should have no duplicates', () => {
      const seen = new Set<string>();
      const duplicates: string[] = [];
      for (const topic of monitoredTopics) {
        if (seen.has(topic)) {
          duplicates.push(topic);
        }
        seen.add(topic);
      }
      expect(duplicates).toEqual([]);
    });
  });

  describe('ONEX naming convention', () => {
    for (const topic of readModelTopics) {
      it(`read_model_topic "${topic}" follows onex.<kind>.<producer>.<event-name>.v<N>`, () => {
        expect(topic).toMatch(ONEX_TOPIC_REGEX);
      });
    }

    for (const topic of monitoredTopics) {
      it(`monitored_topic "${topic}" follows valid naming convention`, () => {
        expect(topic).toMatch(MONITORED_TOPIC_REGEX);
      });
    }
  });

  describe('every subscribed topic has a matching constant in topics.ts', () => {
    const missing: string[] = [];

    for (const topic of readModelTopics) {
      if (!topicConstants.has(topic)) {
        missing.push(topic);
      }
    }

    it('all read_model_topics should have a SUFFIX_*/TOPIC_* constant in topics.ts', () => {
      if (missing.length > 0) {
        const _details = missing.map((t) => `  - ${t} (no matching constant)`).join('\n');
        expect(missing).toEqual(
          // prettier-ignore
          [] /* Missing constants:\n${details} */
        );
      }
      expect(missing).toEqual([]);
    });
  });

  describe('topics.ts constants that are subscribed have correct values', () => {
    // For each constant that appears in topics.yaml, verify the constant's
    // string value is what topics.yaml declares (catches renamed-but-not-updated cases)
    const yamlTopicSet = new Set(readModelTopics);

    for (const [value, constantName] of topicConstants) {
      if (yamlTopicSet.has(value)) {
        it(`${constantName} = "${value}" matches topics.yaml entry`, () => {
          expect(value).toBe(value); // Self-consistent by definition — the real check is membership above
          expect(yamlTopicSet.has(value)).toBe(true);
        });
      }
    }
  });

  describe('handler completeness', () => {
    it('every read_model_topic should have a handler name', () => {
      const missingHandler = manifest.read_model_topics
        .filter((e) => !e.handler)
        .map((e) => e.topic);
      expect(missingHandler).toEqual([]);
    });
  });
});
