// SPDX-FileCopyrightText: 2025 OmniNode.ai Inc.
// SPDX-License-Identifier: MIT

import { defineConfig } from '@playwright/test';

/**
 * Playwright Smoke Test Configuration [OMN-5638]
 *
 * Lightweight config for CI regression gating. Visits every dashboard route
 * in a single Chromium instance and asserts:
 *   - Page returns 200 and renders without JS errors
 *   - No uncaught exceptions in the browser console
 *   - Page does not show the "Not Found" fallback
 *
 * Designed to run in < 3 minutes on CI without Kafka or PostgreSQL.
 */
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'smoke.spec.ts',

  // Generous per-test timeout — pages may take time on first load in CI
  timeout: 30_000,

  expect: {
    timeout: 10_000,
  },

  // Run route tests serially to share the same server instance
  fullyParallel: false,
  workers: 1,

  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,

  reporter: [
    ['list'],
    ...(process.env.CI ? [['github'] as const] : []),
  ],

  use: {
    baseURL: 'http://localhost:3000',
    // No screenshots/video/trace for smoke — keep artifacts small
    screenshot: 'off',
    video: 'off',
    trace: 'off',
  },

  projects: [
    {
      name: 'smoke',
      use: {
        browserName: 'chromium',
        viewport: { width: 1280, height: 720 },
      },
    },
  ],

  webServer: {
    command: 'npm run build && KAFKA_BROKERS= KAFKA_BOOTSTRAP_SERVERS= OMNIDASH_ANALYTICS_DB_URL= ENABLE_REAL_TIME_EVENTS=false SESSION_SECRET=ci-smoke-test-secret PORT=3000 NODE_ENV=production node dist/index.js',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
