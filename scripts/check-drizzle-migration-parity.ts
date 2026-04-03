/* eslint-disable no-console */
/**
 * Drizzle-to-Migration Schema Parity Check
 *
 * SPDX-License-Identifier: MIT
 *
 * Validates that Drizzle pgTable() definitions match SQL migration DDL.
 * Catches the class of bug where Drizzle schema drifts from migrations
 * (OMN-5429, OMN-5430 -- 3+ occurrences historically).
 *
 * Phase 1: Table-definition parity only. Column-level deferred.
 *
 * Usage: npx tsx scripts/check-drizzle-migration-parity.ts
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

interface TableDef {
  name: string;
  source: string;
}

function extractDrizzleTables(filePath: string): TableDef[] {
  const content = readFileSync(filePath, 'utf-8');
  const tables: TableDef[] = [];
  const regex = /pgTable\(\s*["'](\w+)["']/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    tables.push({ name: match[1], source: filePath });
  }
  return tables;
}

function extractMigrationTables(migrationsDir: string): Set<string> {
  const tables = new Set<string>();
  let files: string[];
  try {
    files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
  } catch {
    console.error(`Cannot read migrations directory: ${migrationsDir}`);
    process.exit(1);
  }

  for (const file of files) {
    const content = readFileSync(join(migrationsDir, file), 'utf-8');
    const regex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?(\w+)["']?\s*\(/gi;
    let match;
    while ((match = regex.exec(content)) !== null) {
      tables.add(match[1]);
    }
  }
  return tables;
}

// ---------------------------------------------------------------------------
// Known exceptions (pre-existing, tracked for future cleanup)
// ---------------------------------------------------------------------------

// Tables defined as read-model views or created outside the migration chain.
// Each entry must have a tracking ticket.
const MISSING_MIGRATION_ALLOWLIST = new Set<string>([
  // All previously-missing migrations have been created.
]);

// Tables intentionally defined in multiple schema files (e.g. shared between
// intelligence and omniclaude-state schemas). Tracked for future dedup.
const KNOWN_DUPLICATE_TABLES = new Set([
  'gate_decisions', // shared: intelligence + omniclaude-state
  'epic_run_events', // shared: intelligence + omniclaude-state
  'epic_run_lease', // shared: intelligence + omniclaude-state
  'pr_watch_state', // shared: intelligence + omniclaude-state
  'pipeline_budget_state', // shared: intelligence + omniclaude-state
  'debug_escalation_counts', // shared: intelligence + omniclaude-state
]);

// Main
const schemaFiles = ['shared/intelligence-schema.ts', 'shared/omniclaude-state-schema.ts'];
const migrationsDir = 'migrations';

const drizzleTables = schemaFiles.flatMap((f) => {
  try {
    return extractDrizzleTables(f);
  } catch {
    console.warn(`Warning: Cannot read schema file ${f}, skipping`);
    return [];
  }
});

const migrationTableNames = extractMigrationTables(migrationsDir);

let exitCode = 0;
const findings: string[] = [];

// Check: every Drizzle table must have a matching migration
for (const dt of drizzleTables) {
  if (!migrationTableNames.has(dt.name)) {
    if (MISSING_MIGRATION_ALLOWLIST.has(dt.name)) {
      console.log(
        `[SKIP] Drizzle table "${dt.name}" (${dt.source}) — allowlisted (no migration required)`
      );
    } else {
      findings.push(
        `[ERROR] Drizzle table "${dt.name}" (${dt.source}) has no matching CREATE TABLE in migrations/`
      );
      exitCode = 1;
    }
  }
}

// Check for duplicate Drizzle definitions
const drizzleByName = new Map<string, TableDef[]>();
for (const dt of drizzleTables) {
  const existing = drizzleByName.get(dt.name) || [];
  existing.push(dt);
  drizzleByName.set(dt.name, existing);
}
for (const [name, defs] of drizzleByName) {
  if (defs.length > 1) {
    if (KNOWN_DUPLICATE_TABLES.has(name)) {
      console.log(`[SKIP] Table "${name}" — known cross-schema duplicate (tracked for dedup)`);
    } else {
      const sources = defs.map((d) => d.source).join(', ');
      findings.push(
        `[ERROR] Table "${name}" defined in ${defs.length} Drizzle schema files: ${sources}`
      );
      exitCode = 1;
    }
  }
}

if (findings.length === 0) {
  console.log('Schema parity: all Drizzle tables have matching migrations.');
} else {
  for (const f of findings) {
    console.log(f);
  }
}

process.exit(exitCode);
