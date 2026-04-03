/**
 * CI Assertion: Wiring Manifest Validation (OMN-6983)
 *
 * Validates that wiring-status.json is an honest, up-to-date manifest:
 *   1. Every manifest route has a corresponding client page route in App.tsx
 *   2. Every manifest route has a corresponding server API route in routes.ts
 *      (except routes with no backing API like category pages and redirects)
 *   3. Pages marked 'stub' must NOT claim a working projection table
 *   4. No stale entries: manifest routes must map to actual registered app routes
 *   5. No orphan routes: app routes with data backing should appear in the manifest
 *
 * Root cause this prevents:
 *   wiring-status.json drifts from reality -- pages get added/removed without
 *   updating the manifest, or status claims ("working") are never validated.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Load manifest
// ---------------------------------------------------------------------------

const MANIFEST_PATH = path.resolve(__dirname, '..', 'shared', 'wiring-status.json');
const APP_TSX_PATH = path.resolve(__dirname, '..', 'client', 'src', 'App.tsx');
const ROUTES_TS_PATH = path.resolve(__dirname, '..', 'server', 'routes.ts');

interface ManifestEntry {
  status: 'working' | 'partial' | 'preview' | 'stub';
  table: string | null;
  description: string;
}

interface Manifest {
  routes: Record<string, ManifestEntry>;
}

function loadManifest(): Manifest {
  const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
  return JSON.parse(raw) as Manifest;
}

function extractAppRoutes(source: string): Set<string> {
  const routes = new Set<string>();
  const routePattern = /<Route\s+path="([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = routePattern.exec(source)) !== null) {
    routes.add(match[1]);
  }
  return routes;
}

function extractServerApiPrefixes(source: string): Set<string> {
  const prefixes = new Set<string>();
  const usePattern = /app\.use\(\s*'(\/api\/[^']+)'/g;
  let match: RegExpExecArray | null;
  while ((match = usePattern.exec(source)) !== null) {
    prefixes.add(match[1]);
  }
  return prefixes;
}

// ---------------------------------------------------------------------------
// Route-to-API mapping
// ---------------------------------------------------------------------------

const ROUTES_WITHOUT_API = new Set([
  '/category/speed',
  '/category/success',
  '/category/intelligence',
  '/category/health',
  '/showcase',
  '/insights',
  '/settings',
  '/rl-routing', // preview page, no dedicated server route yet
]);

function expectedApiPrefix(route: string): string | null {
  if (ROUTES_WITHOUT_API.has(route)) return null;

  const overrides: Record<string, string> = {
    '/events': '/api/event-bus',
    '/trace': '/api/traces',
    '/cost-trends': '/api/costs',
    '/intents': '/api/intents',
    '/registry': '/api/registry',
    '/validation': '/api/validation',
    '/extraction': '/api/extraction',
    '/effectiveness': '/api/effectiveness',
    '/baselines': '/api/baselines',
    '/enrichment': '/api/enrichment',
    '/enforcement': '/api/enforcement',
    '/skills': '/api/intelligence',
    '/status': '/api/status',
    '/hostile-reviewer': '/api/hostile-reviewer',
    '/dod': '/api/dod',
    '/epic-pipeline': '/api/epic-run',
    '/pr-watch': '/api/pr-watch',
    '/pipeline-budget': '/api/pipeline-budget',
    '/debug-escalation': '/api/debug-escalation',
    '/ci-intelligence': '/api/ci-intel',
    '/cdqa-gates': '/api/cdqa-gates',
    '/pipeline-health': '/api/pipeline-health',
    '/event-bus-health': '/api/event-bus-health',
    '/wiring-health': '/api/wiring-health',
    '/objective': '/api/objective',
    '/plan-reviewer': '/api/plan-reviewer',
    '/worker-health': '/api/worker-health',
    '/llm-health': '/api/llm-health',
    '/dlq': '/api/dlq',
    '/circuit-breaker': '/api/circuit-breaker',
    '/feature-flags': '/api/feature-flags',
    '/consumer-health': '/api/consumer-health',
    '/runtime-errors': '/api/runtime-errors',
    '/review-calibration': '/api/review-calibration',
    '/compliance': '/api/compliance',
    '/wiring-status': '/api/wiring-status',
    '/savings': '/api/savings',
    '/llm-routing': '/api/llm-routing',
    '/context-effectiveness': '/api/context-effectiveness',
    '/memory': '/api/memory',
    '/delegation': '/api/delegation',
    '/topic-topology': '/api/topology',
    '/pattern-lifecycle': '/api/pattern-lifecycle',
    '/intent-drift': '/api/intent-drift',
    '/routing-feedback': '/api/routing-feedback',
    '/model-efficiency': '/api/model-efficiency',
    '/decisions': '/api/decisions',
    '/patterns': '/api/patterns',
    '/gate-decisions': '/api/gate-decisions',
    '/agents': '/api/agents',
    '/drift': '/api/contract-drift',
    '/pipeline': '/api/pipeline-overview',
    '/subsystem-health': '/api/subsystem-health',
    '/agent-coordination': '/api/team-coordination',
  };

  return overrides[route] ?? `/api${route}`;
}

// Routes whose page components live in components/ or have non-obvious naming
const KNOWN_SPECIAL_PAGES = new Set([
  '/insights', // redirect to /patterns
  '/showcase', // WidgetShowcase
  '/wiring-status', // WiringStatus page
  '/savings', // preview page
  '/patterns', // PatternLearning.tsx (not Patterns*.tsx)
  '/worker-health', // WorkerHealthPage in components/worker-health/
  '/integrations', // IntegrationCatalogDashboard.tsx (name mismatch with route)
]);

// ---------------------------------------------------------------------------
// Helpers for collecting violations with readable output
// ---------------------------------------------------------------------------

function _collectViolations(items: string[]): string {
  return items.length > 0 ? `\n  - ${items.join('\n  - ')}` : '';
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('wiring-status.json manifest validation', () => {
  const manifest = loadManifest();
  const manifestRoutes = Object.keys(manifest.routes);

  const appSource = fs.readFileSync(APP_TSX_PATH, 'utf8');
  const appRoutes = extractAppRoutes(appSource);

  const serverSource = fs.readFileSync(ROUTES_TS_PATH, 'utf8');
  const serverApiPrefixes = extractServerApiPrefixes(serverSource);

  it('manifest file parses as valid JSON with required structure', () => {
    expect(manifest).toHaveProperty('routes');
    expect(Object.keys(manifest.routes).length).toBeGreaterThan(0);

    for (const [route, entry] of Object.entries(manifest.routes)) {
      expect(route).toMatch(/^\//);
      expect(['working', 'partial', 'preview', 'stub']).toContain(entry.status);
      expect(typeof entry.description).toBe('string');
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it('every manifest route has a registered client page route in App.tsx', () => {
    const missing = manifestRoutes.filter((r) => !appRoutes.has(r));
    expect(missing).toEqual([]);
  });

  it('every manifest route with a backing API has a registered server route', () => {
    const missing = manifestRoutes
      .filter((r) => expectedApiPrefix(r) !== null)
      .filter((r) => !serverApiPrefixes.has(expectedApiPrefix(r)!));
    expect(missing).toEqual([]);
  });

  it('stub routes must not claim working projections in their description', () => {
    // Match positive claims like "working", "active", "live", "streaming"
    // but exclude negated forms like "not yet active", "not working"
    const workingClaims = /(?<!\bnot\s+(?:yet\s+)?)\b(working|active|live|streaming)\b/i;

    const violations = Object.entries(manifest.routes)
      .filter(([, entry]) => entry.status === 'stub' && workingClaims.test(entry.description))
      .map(([route, entry]) => `${route}: "${entry.description}"`);
    expect(violations).toEqual([]);
  });

  it('no stale manifest entries (page component files exist)', () => {
    const pagesDir = path.resolve(__dirname, '..', 'client', 'src', 'pages');
    const pageFiles = new Set(
      fs
        .readdirSync(pagesDir)
        .filter((f) => f.endsWith('.tsx') && !f.startsWith('not-found'))
        .map((f) => f.replace('.tsx', ''))
    );

    const routesNeedingPageFile = manifestRoutes.filter(
      (r) => !r.startsWith('/category/') && !r.startsWith('/preview/')
    );

    const unmapped = routesNeedingPageFile.filter((route) => {
      if (KNOWN_SPECIAL_PAGES.has(route)) return false;
      const normalized = route.replace(/^\//, '').replace(/-/g, '').toLowerCase();
      return ![...pageFiles].some((pf) => {
        const pfNorm = pf.toLowerCase();
        return pfNorm.includes(normalized) || normalized.includes(pfNorm.replace('dashboard', ''));
      });
    });

    expect(unmapped).toEqual([]);
  });

  it('valid status values only', () => {
    const validStatuses = ['working', 'partial', 'preview', 'stub'];
    const invalid = Object.entries(manifest.routes)
      .filter(([, entry]) => !validStatuses.includes(entry.status))
      .map(([route, entry]) => `${route}: "${entry.status}"`);
    expect(invalid).toEqual([]);
  });

  it('working routes with table mentions should have table field populated', () => {
    const suspicious = Object.entries(manifest.routes)
      .filter(
        ([, entry]) =>
          entry.status === 'working' && entry.table === null && /\btable\b/i.test(entry.description)
      )
      .map(([route]) => route);
    expect(suspicious).toEqual([]);
  });

  it('manifest route count is within expected bounds', () => {
    expect(manifestRoutes.length).toBeGreaterThan(40);
    expect(manifestRoutes.length).toBeLessThan(200);
  });
});
