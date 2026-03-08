/**
 * CI gate: route files MUST NOT import getIntelligenceDb / tryGetIntelligenceDb (OMN-2325)
 *
 * All data access from route handlers must go through ProjectionService views.
 * Direct SQL queries couple the API layer to storage schema and bypass the
 * projection read path. This test fails if any *-routes.ts file imports the
 * database accessor, enforcing the projection-only architecture.
 *
 * Modeled after no-omninode-bridge-refs.test.ts.
 *
 * Exceptions:
 *   - intelligence-routes.ts: 65+ queries across 40+ endpoints. Migration to
 *     projections is a multi-ticket effort. The agents/summary endpoint already
 *     uses in-memory eventConsumer; remaining endpoints need incremental migration.
 *     TODO(OMN-2325-followup): Split into domain-specific route files, then
 *     create projections for each domain group.
 *   - validation-routes.ts: event handlers (handleValidationRunStarted, etc.)
 *     are write-side concerns that legitimately need DB access. The read-side
 *     route handlers in this file are tracked separately. Once the write-side
 *     is extracted to a dedicated consumer module, this exception can be removed.
 *   - alert-routes.ts: alert CRUD operations require direct DB writes.
 *     Once alerts are event-sourced, this exception can be removed.
 *   - golden-path-routes.ts: golden path CRUD operations require direct DB writes.
 *     Once golden paths are event-sourced, this exception can be removed.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SERVER_DIR = path.resolve(import.meta.dirname, '..');

/**
 * Route files that are TEMPORARILY exempt from this rule.
 * Each entry must have a justification comment above.
 *
 * The goal is to shrink this list to zero over time.
 */
const EXEMPT_FILES = new Set([
  // 65+ queries across 40+ endpoints. Migration is a multi-ticket effort.
  // TODO(OMN-2325-followup): Split into domain-specific route files.
  'intelligence-routes.ts',

  // Write-side event handlers (handleValidationRunStarted, etc.)
  // live alongside read routes in the same file. Once extracted
  // to a separate write-side module, remove this exemption.
  'validation-routes.ts',

  // Alert CRUD requires direct DB writes (not yet event-sourced).
  'alert-routes.ts',

  // Golden path CRUD requires direct DB writes (not yet event-sourced).
  'golden-path-routes.ts',

  // Objective evaluation reads from objective_evaluations, policy_state, and
  // objective_anti_gaming_alerts tables (populated by OMN-2545 ScoringReducer
  // and OMN-2557 PolicyState backends, not yet merged). Once those backends
  // land and projections are created, migrate to ProjectionService views.
  // TODO(OMN-2583-followup): Migrate to projection views after OMN-2545/OMN-2557 merge.
  'objective-routes.ts',

  // Health probe route — probeInsights() queries pattern_learning_artifacts to determine
  // live vs. mock status. This is an operational probe, not a data-access read path.
  // Extracting to a ProjectionService view would add unnecessary indirection for a
  // single-row COUNT(*) health check. TODO(OMN-2924-followup): migrate to a dedicated
  // health-probe abstraction that doesn't import the DB accessor directly.
  'health-data-sources-routes.ts',

  // Backwards-compatibility shim — proxies /api/patterns to pattern_learning_artifacts.
  // The canonical endpoint is /api/intelligence/patterns/patlearn (intelligence-routes.ts,
  // already exempt). This route will be removed once all clients migrate to the canonical
  // endpoint. TODO(OMN-2924-followup): delete once client migration is complete.
  'patterns-routes.ts',

  // Routing config CRUD requires direct DB writes (not yet event-sourced).
  // TODO(OMN-3445-followup): migrate to event-sourced projection.
  'routing-config-routes.ts',

  // Model Efficiency Index reads VTS metrics from model_efficiency_snapshots.
  // Table is populated by a backend reducer (OMN-3923). Once a ProjectionService
  // view is defined for this domain, migrate off direct DB access.
  // TODO(OMN-3923-followup): migrate to ProjectionService view.
  'model-efficiency-routes.ts',
]);

/**
 * Patterns that indicate direct DB access from route files.
 * Uses regex to match actual import statements, avoiding false positives
 * from comments or string literals that happen to mention these identifiers.
 */
const FORBIDDEN_IMPORT_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'getIntelligenceDb', regex: /import\s.*getIntelligenceDb/ },
  { name: 'tryGetIntelligenceDb', regex: /import\s.*tryGetIntelligenceDb/ },
];

/**
 * New omniclaude tables that must NOT be accessed directly from route files.
 * These tables are populated via Kafka → read-model-consumer projections.
 * Routes must access them only through ProjectionService views.
 * (OMN-2596: Wave 2 — 5 new tables)
 */
const PROTECTED_TABLE_NAMES = [
  'gate_decisions',
  'epic_run_lease',
  'epic_run_events',
  'pr_watch_state',
  'pipeline_budget_state',
  'debug_escalation_counts',
];

describe('OMN-2325: No direct DB access in route files', () => {
  it('route files do not import getIntelligenceDb or tryGetIntelligenceDb', () => {
    const routeFiles = fs
      .readdirSync(SERVER_DIR)
      .filter((f) => f.endsWith('-routes.ts') && !EXEMPT_FILES.has(f));

    expect(routeFiles.length).toBeGreaterThan(0);

    const violations: string[] = [];

    for (const file of routeFiles) {
      const filePath = path.join(SERVER_DIR, file);
      const content = fs.readFileSync(filePath, 'utf-8');

      for (const { name, regex } of FORBIDDEN_IMPORT_PATTERNS) {
        if (regex.test(content)) {
          violations.push(`${file} imports ${name}`);
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `Route files must not import DB accessors directly.\n` +
          `Use projectionService.getView('domain').getSnapshot() instead.\n` +
          `Violations:\n  ${violations.join('\n  ')}`
      );
    }
  });

  it('exempt files list only contains files that actually exist', () => {
    const missing = [...EXEMPT_FILES].filter((f) => !fs.existsSync(path.join(SERVER_DIR, f)));
    expect(missing).toEqual([]);
  });

  /**
   * OMN-2596: Verify that the 5 new Wave 2 tables are NOT directly referenced
   * in route files. These tables must only be accessed through Kafka projections
   * and ProjectionService views, enforcing the omnidash DB boundary.
   */
  it('OMN-2596: new Wave 2 tables are not directly referenced in route files', () => {
    const routeFiles = fs
      .readdirSync(SERVER_DIR)
      .filter((f) => f.endsWith('-routes.ts') && !EXEMPT_FILES.has(f));

    const violations: string[] = [];

    for (const file of routeFiles) {
      const filePath = path.join(SERVER_DIR, file);
      const content = fs.readFileSync(filePath, 'utf-8');

      for (const tableName of PROTECTED_TABLE_NAMES) {
        // Check for raw SQL-style or Drizzle ORM references to the table names
        // in import statements or table identifier usage.
        // We look for identifier-like usage (word boundary) to avoid false positives
        // from comments that merely mention the table name as a reference.
        const tableRegex = new RegExp(`\\b${tableName}\\b`);
        // Only flag if there's also a DB import — bare mentions in comments are fine
        const hasDbImport = FORBIDDEN_IMPORT_PATTERNS.some(({ regex }) => regex.test(content));
        if (hasDbImport && tableRegex.test(content)) {
          violations.push(
            `${file} references table "${tableName}" with direct DB import — use a projection view instead`
          );
        }
      }
    }

    expect(violations).toHaveLength(0);
  });

  /**
   * OMN-2596: Verify evt topic constants for all 5 new Wave 2 topics are declared
   * in the shared/topics.ts module.
   */
  it('OMN-2596: Wave 2 evt topics are declared in shared/topics.ts', () => {
    const topicsFile = path.resolve(import.meta.dirname, '../../shared/topics.ts');
    expect(fs.existsSync(topicsFile)).toBe(true);
    const content = fs.readFileSync(topicsFile, 'utf-8');

    const requiredTopics = [
      'onex.evt.omniclaude.gate-decision.v1',
      'onex.evt.omniclaude.epic-run-updated.v1',
      'onex.evt.omniclaude.pr-watch-updated.v1',
      'onex.evt.omniclaude.budget-cap-hit.v1',
      'onex.evt.omniclaude.circuit-breaker-tripped.v1',
    ];

    const missing = requiredTopics.filter((topic) => !content.includes(topic));
    if (missing.length > 0) {
      throw new Error(
        `shared/topics.ts is missing Wave 2 evt topic declarations:\n` +
          `  ${missing.join('\n  ')}\n` +
          `Add these as exported constants following the existing topic naming convention.`
      );
    }
  });
});
