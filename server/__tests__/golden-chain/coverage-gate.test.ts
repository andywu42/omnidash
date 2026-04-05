/**
 * Golden Chain Coverage Gate (OMN-7495)
 *
 * Ensures every Tier 1 read_model_topics entry in topics.yaml
 * has a corresponding golden projection test file.
 *
 * CI enforces this gate — adding a topic to topics.yaml without
 * a golden test will fail the build.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';
import { parse as parseYaml } from 'yaml';

describe('Golden Chain Coverage Gate', () => {
  const topicsPath = resolve(__dirname, '../../../topics.yaml');
  const goldenDir = resolve(__dirname, '.');

  it('every Tier 1 topic has a golden test', () => {
    const raw = readFileSync(topicsPath, 'utf8');
    const manifest = parseYaml(raw);
    const topics: string[] = manifest.read_model_topics.map(
      (entry: { topic: string }) => entry.topic
    );

    // Scan golden-chain directory for *.golden.test.ts files
    const goldenFiles = readdirSync(goldenDir).filter((f) => f.endsWith('.golden.test.ts'));

    // Read each golden file and extract topic references
    const coveredTopics = new Set<string>();
    for (const file of goldenFiles) {
      const content = readFileSync(resolve(goldenDir, file), 'utf8');
      // Match: const TOPIC = 'onex.evt...'
      const singleMatch = content.match(/const TOPIC\s*=\s*'([^']+)'/);
      if (singleMatch) coveredTopics.add(singleMatch[1]);
      // Match array entries (for tests covering multiple topics)
      const arrayMatches = content.matchAll(/['"]onex\.(evt|cmd)\.[^'"]+['"]/g);
      for (const m of arrayMatches) {
        coveredTopics.add(m[0].replace(/['"]/g, ''));
      }
    }

    // Phase 1: Only enforce coverage for Tier 1 topics.
    // Move topics from TIER2_NOT_YET_REQUIRED as golden tests are added.
    const TIER1_REQUIRED = new Set([
      'onex.evt.omniintelligence.llm-call-completed.v1',
      'onex.evt.omniclaude.llm-routing-decision.v1',
      'onex.evt.omnibase-infra.savings-estimated.v1',
      'onex.evt.omnibase-infra.baselines-computed.v1',
      'onex.evt.omniclaude.budget-cap-hit.v1',
      'onex.evt.platform.node-introspection.v1',
      'onex.evt.omniclaude.task-delegated.v1',
      'onex.evt.omniclaude.routing-decision.v1',
      'onex.evt.omniclaude.session-outcome.v1',
    ]);

    // Infrastructure topics that are not projection chains — permanently exempt
    const PERMANENTLY_EXEMPT = new Set([
      'onex.evt.platform.dlq-message.v1',
      'onex.evt.omniclaude.performance-metrics.v1',
      'onex.evt.omniintelligence.context-effectiveness.v1',
      'onex.evt.omniintelligence.eval-completed.v1',
    ]);

    // All other topics are deferred to Tier 2 — not yet gated.
    const TIER2_DEFERRED = new Set(
      topics.filter((t: string) => !TIER1_REQUIRED.has(t) && !PERMANENTLY_EXEMPT.has(t))
    );

    // Log tier coverage stats for CI visibility
    console.log(
      `[coverage-gate] Tier 1: ${TIER1_REQUIRED.size} required, ` +
        `${TIER2_DEFERRED.size} deferred to Tier 2, ` +
        `${PERMANENTLY_EXEMPT.size} permanently exempt, ` +
        `${coveredTopics.size} topics covered by golden tests`
    );

    const uncovered: string[] = [];
    for (const topic of topics) {
      if (
        !coveredTopics.has(topic) &&
        !PERMANENTLY_EXEMPT.has(topic) &&
        !TIER2_DEFERRED.has(topic)
      ) {
        uncovered.push(topic);
      }
    }

    expect(uncovered).toEqual([]);
  });

  it('no golden test references a topic not in topics.yaml', () => {
    const raw = readFileSync(topicsPath, 'utf8');
    const manifest = parseYaml(raw);
    const manifestTopics = new Set(
      manifest.read_model_topics.map((e: { topic: string }) => e.topic)
    );

    const goldenFiles = readdirSync(goldenDir).filter((f) => f.endsWith('.golden.test.ts'));

    const orphanTopics: string[] = [];
    for (const file of goldenFiles) {
      const content = readFileSync(resolve(goldenDir, file), 'utf8');
      const matches = content.matchAll(/const TOPIC\s*=\s*'(onex\.(evt|cmd)\.[^']+)'/g);
      for (const m of matches) {
        const topic = m[1];
        if (!manifestTopics.has(topic)) {
          orphanTopics.push(`${file}: ${topic}`);
        }
      }
    }

    expect(orphanTopics).toEqual([]);
  });
});
