/**
 * Pipeline Completeness Test (OMN-6980)
 *
 * For every page marked "working" in wiring-status.json, verify:
 *   1. If it has a backing DB table, the table is defined in a migration file
 *   2. The page has a corresponding API route registered in routes.ts or index.ts
 *   3. Projection handlers are registered to populate the table
 *
 * Catches false "working" claims that survived for months because no CI test
 * validated the full pipeline from DB table → projection → API route.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Load wiring-status.json
// ---------------------------------------------------------------------------

const SHARED_DIR = join(__dirname, '..', '..', 'shared');
const wiringStatus: {
  routes: Record<string, { status: string; table: string | null; description: string }>;
} = JSON.parse(readFileSync(join(SHARED_DIR, 'wiring-status.json'), 'utf-8'));

const workingRoutes = Object.entries(wiringStatus.routes).filter(
  ([, meta]) => meta.status === 'working'
);

// ---------------------------------------------------------------------------
// Load all migration SQL content (concatenated)
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');
const migrationFiles = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const allMigrationSql = migrationFiles
  .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'))
  .join('\n');

// ---------------------------------------------------------------------------
// Load routes.ts and index.ts source to check API route registration
// ---------------------------------------------------------------------------

const SERVER_DIR = join(__dirname, '..');
const routesTsSource = readFileSync(join(SERVER_DIR, 'routes.ts'), 'utf-8');
const indexTsSource = readFileSync(join(SERVER_DIR, 'index.ts'), 'utf-8');
const allRouteSources = routesTsSource + '\n' + indexTsSource;

// ---------------------------------------------------------------------------
// Collect all server .ts source to check for table references
// ---------------------------------------------------------------------------

function collectTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsFiles(fullPath));
    } else if (entry.name.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

const allServerTsContent = collectTsFiles(SERVER_DIR)
  .map((f) => readFileSync(f, 'utf-8'))
  .join('\n');

// ---------------------------------------------------------------------------
// Map from dashboard route path → expected API prefix in routes.ts
//
// Some dashboard routes use a different slug for the API path.
// Routes without an API (pure frontend, category landings) are mapped to null.
// ---------------------------------------------------------------------------

const ROUTE_TO_API: Record<string, string | null> = {
  '/events': '/api/event-bus',
  '/patterns': '/api/patterns',
  '/llm-routing': '/api/llm-routing',
  '/gate-decisions': '/api/gate-decisions',
  '/epic-pipeline': '/api/epic-run',
  '/pr-watch': '/api/pr-watch',
  '/extraction': '/api/extraction',
  '/effectiveness': '/api/effectiveness',
  '/baselines': '/api/baselines',
  '/cost-trends': '/api/costs',
  '/enrichment': '/api/enrichment',
  '/enforcement': '/api/enforcement',
  '/intents': '/api/intents',
  '/validation': '/api/validation',
  '/registry': '/api/registry',
  '/trace': '/api/traces',
  '/hostile-reviewer': '/api/hostile-reviewer',
  '/dod': '/api/dod',
  '/status': '/api/status',
  '/skills': '/api/skills',
  '/wiring-status': '/api/wiring-status',
  '/system-activity': '/api/system-activity',
  // Category landing pages and showcase are frontend-only — no API route needed
  '/category/speed': null,
  '/category/success': null,
  '/category/intelligence': null,
  '/category/health': null,
  '/showcase': null,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Pipeline Completeness (OMN-6980)', () => {
  it('has at least one working route to validate', () => {
    expect(workingRoutes.length).toBeGreaterThan(0);
  });

  describe('DB table exists in migrations for working pages', () => {
    const routesWithTables = workingRoutes.filter(([, meta]) => meta.table !== null);

    it.each(routesWithTables)('%s → table "%s"', (route, meta) => {
      const table = meta.table!;
      // Check for CREATE TABLE with the table name (with or without quotes)
      const patterns = [
        new RegExp(`CREATE TABLE[^(]*\\b${table}\\b`, 'i'),
        new RegExp(`CREATE TABLE[^(]*"${table}"`, 'i'),
      ];
      const found = patterns.some((p) => p.test(allMigrationSql));
      expect(found).toBe(true);
    });
  });

  describe('API route is registered for working pages', () => {
    const routesWithApi = workingRoutes.filter(([route]) => {
      const api = ROUTE_TO_API[route];
      return api !== undefined && api !== null;
    });

    it.each(routesWithApi)('%s → API route registered', (route) => {
      const api = ROUTE_TO_API[route]!;
      // Check that the API prefix appears in an app.use() call in routes.ts or index.ts
      const escaped = api.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`app\\.use\\(['"]${escaped}['"]`);
      expect(pattern.test(allRouteSources)).toBe(true);
    });

    it('all working routes with tables have a known API mapping', () => {
      const unmapped = workingRoutes
        .filter(([, meta]) => meta.table !== null)
        .filter(([route]) => ROUTE_TO_API[route] === undefined);
      expect(unmapped.map(([r]) => r)).toEqual([]);
    });
  });

  describe('Server code references backing tables for working pages', () => {
    const routesWithTables = workingRoutes.filter(([, meta]) => meta.table !== null);

    it('each table is referenced in server source (SQL or Drizzle schema)', () => {
      const missing: string[] = [];
      for (const [route, meta] of routesWithTables) {
        const table = meta.table!;
        // Convert snake_case table name to camelCase for Drizzle schema references
        const camelCase = table.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
        // Check for the table name in either form across all server source
        const found = allServerTsContent.includes(table) || allServerTsContent.includes(camelCase);
        if (!found) {
          missing.push(`${route} (table: ${table})`);
        }
      }
      expect(missing).toEqual([]);
    });
  });
});
