// SPDX-FileCopyrightText: 2025 OmniNode.ai Inc.
// SPDX-License-Identifier: MIT

/**
 * Playwright Smoke Tests — CI Regression Gate [OMN-5638]
 *
 * Visits every registered dashboard route in a real Chromium browser and asserts:
 *   1. HTTP 200 response
 *   2. Page does not show the "Not Found" fallback
 *   3. Page renders meaningful content (not a blank/white screen)
 *
 * These tests run against a production build with no Kafka or PostgreSQL.
 * Dashboards that depend on live data show empty/mock states, which is fine.
 * The test catches **page-level crashes** — broken imports, render failures,
 * and pages that "go dark" after a PR merges.
 *
 * Console errors are NOT asserted — many pages log benign warnings when
 * external services (Kafka, intelligence API) are unavailable. A future
 * follow-up ticket can add strict console error checking with an allowlist.
 *
 * Route catalog is derived from client/src/App.tsx Route declarations.
 * When adding a new route to App.tsx, add it here too — the catalog
 * completeness test at the bottom will catch omissions.
 *
 * Run locally:
 *   npx playwright test --config playwright.smoke.config.ts
 *
 * @see OMN-5638
 */

import { test, expect } from '@playwright/test';

// ---------------------------------------------------------------------------
// Route catalog — every route registered in App.tsx
// ---------------------------------------------------------------------------
// Grouped by section for readability. Flat array for iteration.
// Excludes /insights (redirects to /patterns) and /events-legacy (deprecated).

const DASHBOARD_ROUTES = [
  // Core dashboards
  '/',
  '/category/speed',
  '/category/success',
  '/category/intelligence',
  '/category/health',

  // Advanced — Monitoring
  '/events',
  '/live-events',
  '/extraction',
  '/effectiveness',
  '/effectiveness/latency',
  '/effectiveness/utilization',
  '/effectiveness/ab',
  '/graph',
  '/cost-trends',

  // Advanced — Intelligence
  '/intents',
  '/patterns',
  '/enforcement',
  '/enrichment',
  '/context-effectiveness',
  '/llm-routing',
  '/memory',

  // Advanced — System
  '/registry',
  '/discovery',
  '/validation',
  '/baselines',

  // Advanced — Tools
  '/trace',
  '/showcase',

  // Platform pages
  '/intelligence',
  '/code',
  '/event-bus',
  '/knowledge',
  '/health',
  '/developer',
  '/chat',
  '/demo',
  '/why',
  '/topic-topology',
  '/status',
  '/skills',
  '/gate-decisions',
  '/epic-pipeline',
  '/pr-watch',
  '/pipeline-budget',
  '/debug-escalation',
  '/ci-intelligence',
  '/cdqa-gates',
  '/pipeline-health',
  '/event-bus-health',
  '/wiring-health',
  '/objective',
  '/plan-reviewer',
  '/worker-health',
  '/llm-health',
  '/dlq',
  '/circuit-breaker',
  '/feature-flags',
  '/consumer-health',
  '/runtime-errors',
  '/rl-routing',
  '/model-efficiency',
  '/delegation',
  '/decisions',
  '/dod',
  '/intent-drift',

  // Preview pages
  '/preview/analytics',
  '/preview/health',
  '/preview/settings',
  '/preview/showcase',
  '/preview/contracts',
  '/preview/tech-debt',
  '/preview/pattern-lineage',
  '/preview/composer',
  '/preview/savings',
  '/preview/agent-registry',
  '/preview/agent-network',
  '/preview/intelligence-analytics',
  '/preview/platform-monitoring',
  '/preview/agent-management',
  '/preview/code-intelligence-suite',
  '/preview/architecture-networks',
  '/preview/developer-tools',
] as const;

// ---------------------------------------------------------------------------
// Test suite — "page goes dark" regression gate
// ---------------------------------------------------------------------------

test.describe('Dashboard Smoke Tests [OMN-5638]', () => {
  for (const route of DASHBOARD_ROUTES) {
    test(`${route} renders without crashing`, async ({ page }) => {
      // Navigate using 'domcontentloaded' — some pages make requests to
      // external services (localhost:8053, etc.) that don't exist in CI,
      // so 'networkidle' would timeout on those pages.
      const response = await page.goto(route, {
        waitUntil: 'domcontentloaded',
        timeout: 15_000,
      });

      // Give React time to mount and render after DOM is loaded
      await page.waitForTimeout(2_000);

      // 1. Assert HTTP 200
      expect(response?.status(), `${route} should return HTTP 200`).toBe(200);

      // 2. Assert page is not the "Not Found" fallback
      const notFoundVisible = await page.locator('text=Page Not Found').isVisible().catch(() => false);
      expect(notFoundVisible, `${route} should not show "Page Not Found"`).toBe(false);

      // 3. Assert the page has rendered meaningful content
      // A completely broken page (missing import, crash before any render)
      // will have an almost-empty body. Pages with ErrorBoundary fallbacks
      // still render content, which is acceptable — the page is not "dark".
      const bodyText = await page.textContent('body') ?? '';
      const trimmedBody = bodyText.replace(/\s+/g, ' ').trim();
      expect(
        trimmedBody.length,
        `${route} should render content (got ${trimmedBody.length} chars)`
      ).toBeGreaterThan(10);
    });
  }
});

// ---------------------------------------------------------------------------
// Route catalog completeness check
// ---------------------------------------------------------------------------

test('route catalog is comprehensive (matches App.tsx)', async () => {
  // This test ensures the route list above stays in sync with App.tsx.
  // If a developer adds a route to App.tsx but forgets to add it here,
  // CI will NOT catch the new page crashing. This test fails loudly to
  // remind them.

  const fs = await import('node:fs');
  const path = await import('node:path');

  const appTsxPath = path.resolve(process.cwd(), 'client/src/App.tsx');
  const appTsx = fs.readFileSync(appTsxPath, 'utf-8');

  // Extract all route paths from App.tsx
  const routeRegex = /Route\s+path="([^"]+)"/g;
  const appRoutes = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = routeRegex.exec(appTsx)) !== null) {
    appRoutes.add(match[1]);
  }

  const smokeRoutes = new Set<string>(DASHBOARD_ROUTES);

  // Known exclusions (redirects, deprecated, or login-only pages)
  const EXCLUDED_ROUTES = new Set([
    '/insights',       // Redirects to /patterns
    '/events-legacy',  // Deprecated
  ]);

  // Find routes in App.tsx that are missing from our smoke test list
  const missingFromSmoke: string[] = [];
  for (const route of appRoutes) {
    if (!smokeRoutes.has(route) && !EXCLUDED_ROUTES.has(route)) {
      missingFromSmoke.push(route);
    }
  }

  expect(
    missingFromSmoke,
    `These routes exist in App.tsx but are missing from smoke.spec.ts DASHBOARD_ROUTES. ` +
    `Add them to the smoke test or to EXCLUDED_ROUTES if they should be skipped:\n` +
    missingFromSmoke.map(r => `  - ${r}`).join('\n')
  ).toHaveLength(0);
});
