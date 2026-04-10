/**
 * CI Assertion: Event Registration Coverage Test (OMN-2910, OMN-5192, OMN-5251)
 *
 * Asserts that every topic in topics.yaml has a corresponding handler
 * in the projection handler modules.
 *
 * Root cause this prevents:
 *   When a new topic is added to topics.yaml (subscribed) but no
 *   matching handler case is added, messages arrive silently and are discarded.
 *   Dashboard pages show empty state with no error -- invisible drift.
 *
 * Approach (OMN-5192 decomposition + OMN-5251 topics.yaml source):
 *   1. Load topics from topics.yaml via the manifest loader (OMN-5251).
 *   2. Parse handler source files (consumers/read-model/*-projections.ts) to
 *      extract case labels from switch statements and topic set literals.
 *   3. Resolve identifier names -> string values via shared/topics.ts.
 *   4. Assert: for each topic string in topics.yaml, that topic appears
 *      in the combined set of handled topics across all handler files.
 *
 * Also scans the orchestrator (read-model-consumer.ts) for any remaining case
 * branches to support both the decomposed and any transitional architectures.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as sharedTopics from '@shared/topics';
import { loadManifestTopics, resetManifestCache } from '../server/services/topic-manifest-loader';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract topic tokens from case labels and Set/array topic declarations in
 * a source file. Returns raw tokens (identifier names or string literals).
 */
function extractTopicTokens(filePath: string): string[] {
  const source = fs.readFileSync(filePath, 'utf8');
  const tokens: string[] = [];

  // Extract case labels: 'literal', "literal", or IDENTIFIER
  const casePattern = /\bcase\s+(?:'([^']+)'|"([^"]+)"|([A-Z][A-Z0-9_]+))\s*:/g;
  let match: RegExpExecArray | null;
  while ((match = casePattern.exec(source)) !== null) {
    const token = match[1] ?? match[2] ?? match[3];
    if (token) tokens.push(token);
  }

  // Also extract identifiers and string literals in Set/array declarations
  // (for handlers that use `new Set([...])` or array membership checks)
  const setPattern = /new Set\(\[([^\]]+)\]\)/gs;
  while ((match = setPattern.exec(source)) !== null) {
    const inner = match[1];
    // Extract identifiers
    const idPattern = /([A-Z][A-Z0-9_]+)/g;
    let idMatch: RegExpExecArray | null;
    while ((idMatch = idPattern.exec(inner)) !== null) {
      tokens.push(idMatch[1]);
    }
    // Extract string literals
    const strPattern = /['"]([^'"]+)['"]/g;
    let strMatch: RegExpExecArray | null;
    while ((strMatch = strPattern.exec(inner)) !== null) {
      tokens.push(strMatch[1]);
    }
  }

  return tokens;
}

/**
 * Build a map of exported string constants from shared/topics.ts.
 *
 * This lets us resolve identifier names like SUFFIX_OMNICLAUDE_GATE_DECISION
 * to their actual string values (e.g. "onex.evt.omniclaude.gate-decision.v1").
 */
function buildConstantResolver(): Map<string, string> {
  const resolver = new Map<string, string>();
  for (const [key, value] of Object.entries(sharedTopics)) {
    if (typeof value === 'string') {
      resolver.set(key, value);
    }
  }
  return resolver;
}

/**
 * Given a list of raw tokens and a constant resolver map, return the set
 * of resolved topic string values.
 */
function resolveCaseTokens(tokens: string[], resolver: Map<string, string>): Set<string> {
  const resolved = new Set<string>();
  for (const token of tokens) {
    if (resolver.has(token)) {
      resolved.add(resolver.get(token)!);
    } else if (token.includes('.')) {
      // Already a string literal topic name
      resolved.add(token);
    }
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Source file paths
// ---------------------------------------------------------------------------

const HANDLER_DIR = path.resolve(__dirname, '../server/consumers/read-model');
const ORCHESTRATOR_PATH = path.resolve(__dirname, '../server/read-model-consumer.ts');

// All handler files that contain projection logic
const HANDLER_FILES = [
  path.join(HANDLER_DIR, 'omniclaude-projections.ts'),
  path.join(HANDLER_DIR, 'dod-projections.ts'),
  path.join(HANDLER_DIR, 'omniintelligence-projections.ts'),
  path.join(HANDLER_DIR, 'omnibase-infra-projections.ts'),
  path.join(HANDLER_DIR, 'platform-projections.ts'),
  // OmniMemory projection handler (OMN-5290)
  path.join(HANDLER_DIR, 'omnimemory-projections.ts'),
  // Change Control projection handler (OMN-6753)
  path.join(HANDLER_DIR, 'change-control-projections.ts'),
  // Eval projection handler
  path.join(HANDLER_DIR, 'eval-projections.ts'),
  // OmniMarket projection handler (OMN-7920)
  path.join(HANDLER_DIR, 'omnimarket-projections.ts'),
  // Bloom eval projection handler (OMN-8146)
  path.join(HANDLER_DIR, 'bloom-eval-projections.ts'),
  // Sweep result projection handler (OMN-8172)
  path.join(HANDLER_DIR, 'sweep-projections.ts'),
];

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('OMN-2910/OMN-5251: topics.yaml -> handler coverage', () => {
  beforeEach(() => {
    resetManifestCache();
    process.env.TOPICS_MANIFEST_PATH = path.resolve(__dirname, '../topics.yaml');
  });

  afterEach(() => {
    resetManifestCache();
    delete process.env.TOPICS_MANIFEST_PATH;
  });

  it('every topic in topics.yaml has a corresponding handler', () => {
    const manifestTopics = loadManifestTopics();

    // Collect handled topics from all handler files + orchestrator
    const resolver = buildConstantResolver();
    const handledTopics = new Set<string>();

    for (const filePath of [...HANDLER_FILES, ORCHESTRATOR_PATH]) {
      if (!fs.existsSync(filePath)) continue;
      const tokens = extractTopicTokens(filePath);
      for (const resolved of resolveCaseTokens(tokens, resolver)) {
        handledTopics.add(resolved);
      }
    }

    // Assert: every subscribed topic has a handler.
    const missingHandlers: string[] = [];
    for (const topic of manifestTopics) {
      if (!handledTopics.has(topic)) {
        missingHandlers.push(topic);
      }
    }

    if (missingHandlers.length > 0) {
      throw new Error(
        `The following topics appear in topics.yaml but have no ` +
          `corresponding handler:\n` +
          missingHandlers.map((t) => `  - ${t}`).join('\n') +
          `\n\nAdd a handler case in the appropriate projection file in ` +
          `server/consumers/read-model/.`
      );
    }

    // Sanity check: we extracted at least as many cases as manifest topics.
    expect(handledTopics.size).toBeGreaterThanOrEqual(manifestTopics.length);
  });

  it('no orphaned handler cases for topics not in topics.yaml', () => {
    const manifestTopics = loadManifestTopics();
    const subscribedSet = new Set<string>(manifestTopics);

    const resolver = buildConstantResolver();
    const handledTopics = new Set<string>();

    for (const filePath of [...HANDLER_FILES, ORCHESTRATOR_PATH]) {
      if (!fs.existsSync(filePath)) continue;
      const tokens = extractTopicTokens(filePath);
      for (const resolved of resolveCaseTokens(tokens, resolver)) {
        handledTopics.add(resolved);
      }
    }

    const orphanedCases: string[] = [];
    for (const handledTopic of handledTopics) {
      if (!subscribedSet.has(handledTopic)) {
        orphanedCases.push(handledTopic);
      }
    }

    const orphanedMsg =
      orphanedCases.length > 0
        ? `Orphaned handler cases not in topics.yaml: ${orphanedCases.join(', ')}. ` +
          `Either add them to topics.yaml or remove the dead handler case.`
        : '';
    expect(orphanedMsg).toBe('');
  });
});
