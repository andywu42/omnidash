/* eslint-disable no-console */
// SPDX-FileCopyrightText: 2025 OmniNode.ai Inc.
// SPDX-License-Identifier: MIT

/**
 * Dashboard route smoke test [OMN-5181]
 *
 * Fetches every known dashboard route and asserts a 2xx response.
 * Used in CI after `npm run build && npm run start` to catch pages
 * that crash on render (missing env vars, bad imports, etc.).
 *
 * Usage:
 *   SMOKE_URL=http://localhost:3000 tsx scripts/dashboard-smoke-test.ts
 */

const ROUTES = [
  '/',
  '/events',
  '/extraction',
  '/intents',
  '/patterns',
  '/enrichment',
  '/llm-routing',
  '/registry',
  '/cost-trends',
  '/effectiveness',
  '/baselines',
  '/validation',
  '/enforcement',
  '/category/speed',
  '/category/success',
  '/category/intelligence',
  '/category/health',
  '/pipeline-health',
  '/worker-health',
  '/trace',
  '/insights',
  '/cdqa-gates',
  '/objective',
  '/model-efficiency',
  '/event-bus-health',
  '/showcase',
  '/plan-reviewer',
  '/agents',
  '/drift',
  '/pipeline',
  '/settings',
];

async function smoke(): Promise<void> {
  const base = process.env.SMOKE_URL || 'http://localhost:3000';
  const results: { route: string; status: string; ok: boolean }[] = [];
  let failures = 0;

  for (const route of ROUTES) {
    try {
      const res = await fetch(`${base}${route}`, {
        signal: AbortSignal.timeout(10_000),
      });
      const ok = res.ok;
      results.push({ route, status: String(res.status), ok });
      if (!ok) {
        console.error(`FAIL ${route}: ${res.status}`);
        failures++;
      } else {
        console.log(`OK   ${route}`);
      }
    } catch (e) {
      const msg = (e as Error).message;
      console.error(`FAIL ${route}: ${msg}`);
      results.push({ route, status: msg, ok: false });
      failures++;
    }
  }

  console.log(`\n${ROUTES.length - failures}/${ROUTES.length} routes OK`);
  process.exit(failures > 0 ? 1 : 0);
}

smoke();
