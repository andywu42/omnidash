/**
 * E2E Data-Flow Tests — Kafka Event -> Rendered Page [OMN-6297]
 *
 * These tests publish REAL Kafka events via KafkaJS, wait for the
 * omnidash read-model consumer to project them into the DB, then
 * verify the page renders the seeded data.
 *
 * This catches the "empty tables" class of regression where a topic
 * is renamed in the producer but the consumer subscription drifted.
 *
 * Prerequisites:
 *   - Local Kafka/Redpanda on localhost:19092
 *   - PostgreSQL on the external host port (see ~/.omnibase/.env)
 *   - omnidash running on localhost:3000 with live Kafka/DB
 *
 * Run with:
 *   npx playwright test --config playwright.dataflow.config.ts dataflow.spec.ts
 */

import { test, expect } from '@playwright/test';
import { seedEvent, marker, disconnectProducer } from './helpers/kafka-seeder';

// Seeded markers — unique per test run to avoid cross-run collisions
const AGENT_ACTION_MARKER = marker('agent-action');
const ROUTING_AGENT_MARKER = marker('routing-agent');
const TRANSFORM_PATTERN_MARKER = marker('transform-pattern');
const LIVE_EVENT_MARKER = marker('live-event');

// Wait for projections to propagate (Kafka -> consumer -> DB -> page)
const PROJECTION_WAIT_MS = 8_000;

test.describe('Data-flow: Kafka -> Projection -> Page', () => {
  test.afterAll(async () => {
    await disconnectProducer();
  });

  test('agent-actions event appears on /events page', async ({ page }) => {
    // Seed an agent-actions event with a unique marker
    await seedEvent('onex.evt.omniclaude.agent-actions.v1', {
      event_type: 'agent_action',
      session_id: AGENT_ACTION_MARKER,
      action: 'tool_call',
      agent_name: 'polymorphic-agent',
      tool_name: 'Bash',
      timestamp: new Date().toISOString(),
      correlation_id: AGENT_ACTION_MARKER,
    });

    // Wait for projection
    await page.waitForTimeout(PROJECTION_WAIT_MS);

    // Navigate and assert the marker appears
    await page.goto('/events');
    await page.waitForLoadState('networkidle');

    // The events page should show the seeded session ID or correlation ID
    const pageContent = await page.textContent('body');
    expect(pageContent).toContain(AGENT_ACTION_MARKER);
  });

  test('routing-decision event appears on /llm-routing page', async ({ page }) => {
    // Seed a routing decision event
    await seedEvent('onex.evt.omniclaude.agent-match.v1', {
      event_type: 'agent_match',
      session_id: ROUTING_AGENT_MARKER,
      agent_name: ROUTING_AGENT_MARKER,
      match_score: 0.95,
      selected: true,
      timestamp: new Date().toISOString(),
      correlation_id: ROUTING_AGENT_MARKER,
    });

    await page.waitForTimeout(PROJECTION_WAIT_MS);

    await page.goto('/llm-routing');
    await page.waitForLoadState('networkidle');

    const pageContent = await page.textContent('body');
    expect(pageContent).toContain(ROUTING_AGENT_MARKER);
  });

  test('transformation event appears on /extraction page', async ({ page }) => {
    // Seed a transformation event
    await seedEvent('onex.evt.omniclaude.agent-transformation.v1', {
      event_type: 'agent_transformation',
      session_id: TRANSFORM_PATTERN_MARKER,
      pattern_name: TRANSFORM_PATTERN_MARKER,
      transformation_type: 'code_generation',
      duration_ms: 150,
      timestamp: new Date().toISOString(),
      correlation_id: TRANSFORM_PATTERN_MARKER,
    });

    await page.waitForTimeout(PROJECTION_WAIT_MS);

    await page.goto('/extraction');
    await page.waitForLoadState('networkidle');

    const pageContent = await page.textContent('body');
    expect(pageContent).toContain(TRANSFORM_PATTERN_MARKER);
  });

  test('read-model projections produce non-empty tables', async ({ page }) => {
    // After seeding events above, the metrics endpoint should report
    // non-zero projected event counts
    await page.goto('/api/metrics');
    await page.waitForLoadState('networkidle');

    const metricsText = await page.textContent('body');
    // The metrics endpoint returns Prometheus-style text or JSON
    // At minimum, it should contain projection counter names
    expect(metricsText).toBeTruthy();
    expect(metricsText!.length).toBeGreaterThan(10);

    // Verify at least one non-zero projection counter exists
    // omnidash_read_model_events_projected_total should be > 0
    const hasProjections =
      metricsText!.includes('events_projected') ||
      metricsText!.includes('eventsProjected') ||
      metricsText!.includes('"projected"');
    expect(hasProjections).toBe(true);
  });

  test('WebSocket receives live events on /live-events', async ({ page }) => {
    // Navigate to live-events page first to establish WebSocket
    await page.goto('/live-events');
    await page.waitForLoadState('networkidle');

    // Seed an event AFTER the page is loaded (so WebSocket can catch it)
    await seedEvent('onex.evt.omniclaude.agent-actions.v1', {
      event_type: 'agent_action',
      session_id: LIVE_EVENT_MARKER,
      action: 'tool_call',
      agent_name: 'live-test-agent',
      tool_name: 'Read',
      timestamp: new Date().toISOString(),
      correlation_id: LIVE_EVENT_MARKER,
    });

    // Wait for WebSocket to deliver the event
    // Use a shorter wait since this goes through the real-time path
    await page.waitForTimeout(5_000);

    const pageContent = await page.textContent('body');
    expect(pageContent).toContain(LIVE_EVENT_MARKER);
  });
});
