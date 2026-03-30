// SPDX-FileCopyrightText: 2025 OmniNode.ai Inc.
// SPDX-License-Identifier: MIT

import { defineConfig } from '@playwright/test';

/**
 * Playwright Data-Flow & Behavioral Test Configuration [OMN-6292]
 *
 * Config for tests that require LIVE local infrastructure:
 *   - Kafka/Redpanda on localhost:19092
 *   - PostgreSQL on the external host port (see ~/.omnibase/.env)
 *   - omnidash dev server on localhost:3000
 *
 * Targets dataflow.spec.ts (Kafka -> projection -> page) and
 * behavioral.spec.ts (interactions, filters, sorts, responsive).
 *
 * Designed for LOCAL execution only (during autopilot close-out or
 * developer verification), NOT remote CI. Infrastructure readiness
 * is the caller's responsibility — this config owns browser test
 * behavior only.
 */
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: ['dataflow.spec.ts', 'behavioral.spec.ts', 'p0-data-verification.spec.ts'],

  // Data-flow tests may wait for Kafka -> projection -> render pipeline
  timeout: 60_000,

  expect: {
    // Projections may take several seconds to appear on page
    timeout: 15_000,
  },

  // Sequential execution — data-flow tests seed events that must not
  // collide across parallel workers
  fullyParallel: false,
  workers: 1,

  forbidOnly: !!process.env.CI,
  retries: 0,

  reporter: [['list'], ['html', { outputFolder: 'playwright-report-dataflow', open: 'never' }]],

  use: {
    baseURL: 'http://localhost:3000',

    // Capture artifacts on failure for post-mortem debugging
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },

  projects: [
    {
      name: 'dataflow',
      use: {
        browserName: 'chromium',
        viewport: { width: 1280, height: 720 },
      },
    },
  ],

  // No webServer block — the caller (autopilot/dashboard-sweep) is
  // responsible for ensuring omnidash is running on localhost:3000
  // with live Kafka and DB connections.
});
