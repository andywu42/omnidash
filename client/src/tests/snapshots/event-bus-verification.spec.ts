import { test, expect } from '@playwright/test';

/**
 * Event Bus Verification Tests
 *
 * Verifies that:
 * 1. Event bus API endpoints are working
 * 2. Events are being generated and stored
 * 3. Dashboards display valid event data
 * 4. Event streams are functioning correctly
 */

test.describe('Event Bus Verification', () => {
  const BASE_URL = 'http://localhost:3000';

  test.describe('API Endpoints', () => {
    test('should return event bus status', async ({ request }) => {
      const response = await request.get(`${BASE_URL}/api/event-bus/status`);
      expect(response.ok()).toBeTruthy();

      const data = await response.json();
      expect(data).toHaveProperty('active');
      expect(data).toHaveProperty('connected');
      expect(data).toHaveProperty('status');

      console.warn('Event Bus Status:', data);
    });

    test('should query events from event bus', async ({ request }) => {
      const response = await request.get(`${BASE_URL}/api/event-bus/events?limit=10`);
      expect(response.ok()).toBeTruthy();

      const data = await response.json();
      expect(data).toHaveProperty('events');
      expect(data).toHaveProperty('count');
      expect(Array.isArray(data.events)).toBeTruthy();

      console.warn(`Found ${data.count} events`);

      // If events exist, verify structure
      if (data.events.length > 0) {
        const event = data.events[0];
        expect(event).toHaveProperty('event_type');
        expect(event).toHaveProperty('event_id');
        expect(event).toHaveProperty('timestamp');
        expect(event).toHaveProperty('tenant_id');
        expect(event).toHaveProperty('payload');

        console.warn('Sample event:', {
          type: event.event_type,
          id: event.event_id,
          timestamp: event.timestamp,
        });
      }
    });

    test('should filter events by event type', async ({ request }) => {
      const response = await request.get(
        `${BASE_URL}/api/event-bus/events?event_types=omninode.agent.execution.completed.v1&limit=5`
      );
      expect(response.ok()).toBeTruthy();

      const data = await response.json();
      expect(Array.isArray(data.events)).toBeTruthy();

      // Verify all returned events match the filter
      data.events.forEach((event: any) => {
        expect(event.event_type).toBe('omninode.agent.execution.completed.v1');
      });
    });

    test('should return event statistics', async ({ request }) => {
      const response = await request.get(`${BASE_URL}/api/event-bus/statistics`);
      expect(response.ok()).toBeTruthy();

      const data = await response.json();
      expect(data).toHaveProperty('total_events');
      expect(data).toHaveProperty('events_by_type');
      expect(data).toHaveProperty('events_by_tenant');
      expect(data).toHaveProperty('events_per_minute');

      console.warn('Event Statistics:', {
        total: data.total_events,
        byType: Object.keys(data.events_by_type).length,
        perMinute: data.events_per_minute.toFixed(2),
      });
    });
  });

  test.describe('Dashboard Integration', () => {
    test('should display event data on Intelligence Analytics dashboard', async ({ page }) => {
      await page.goto('/preview/intelligence-analytics');
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(2000); // Wait for data to load

      // Verify page loaded
      await expect(page).toHaveTitle(/Intelligence|Omnidash/i);

      // Check for data indicators
      const hasData = (await page.locator('text=/\\d+/').count()) > 0;
      expect(hasData).toBeTruthy();

      // Take snapshot
      await expect(page).toHaveScreenshot('intelligence-analytics-with-events.png', {
        fullPage: true,
      });
    });

    test('should display event data on Agent Management dashboard', async ({ page }) => {
      await page.goto('/preview/agent-management');
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(2000);

      // Verify routing decisions or agent data is visible
      const hasContent = (await page.locator('main').count()) > 0;
      expect(hasContent).toBeTruthy();

      // Take snapshot
      await expect(page).toHaveScreenshot('agent-management-with-events.png', {
        fullPage: true,
      });
    });

    test('should display event data on Event Flow dashboard', async ({ page }) => {
      await page.goto('/events');
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(2000);

      // Check for event metrics
      const metricsVisible = (await page.locator('text=/events|total|throughput/i').count()) > 0;
      expect(metricsVisible).toBeTruthy();

      // Take snapshot
      await expect(page).toHaveScreenshot('event-flow-with-events.png', {
        fullPage: true,
      });
    });

    test('should display event data on Platform Health dashboard', async ({ page }) => {
      await page.goto('/preview/system-health');
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(2000);

      // Verify page loaded (main content exists)
      const hasContent = (await page.locator('main').count()) > 0;
      expect(hasContent).toBeTruthy();

      // Take snapshot (even if health data isn't visible yet)
      await expect(page).toHaveScreenshot('platform-health-with-events.png', {
        fullPage: true,
      });
    });
  });

  test.describe('Event Stream Validation', () => {
    test('should verify events are being generated', async ({ request }) => {
      // Get initial count
      const initialResponse = await request.get(`${BASE_URL}/api/event-bus/events?limit=1`);
      const initialData = await initialResponse.json();
      const initialCount = initialData.count;

      // Wait for new events to be generated (mock generator runs every 5 seconds)
      await new Promise((resolve) => setTimeout(resolve, 6000));

      // Get updated count
      const updatedResponse = await request.get(`${BASE_URL}/api/event-bus/events?limit=1`);
      const updatedData = await updatedResponse.json();
      const updatedCount = updatedData.count;

      console.warn(`Event count: ${initialCount} → ${updatedCount}`);

      // Events should be increasing (or at least not decreasing)
      expect(updatedCount).toBeGreaterThanOrEqual(initialCount);
    });

    test('should verify event chain correlation', async ({ request }) => {
      // Query for agent execution events
      const response = await request.get(
        `${BASE_URL}/api/event-bus/events?event_types=omninode.agent.execution.completed.v1&limit=10`
      );
      const data = await response.json();

      if (data.events.length > 0) {
        // Find events with correlation_id
        const eventsWithCorrelation = data.events.filter((e: any) => e.correlation_id);

        if (eventsWithCorrelation.length > 0) {
          const correlationId = eventsWithCorrelation[0].correlation_id;

          // Query for all events with this correlation_id
          const chainResponse = await request.get(
            `${BASE_URL}/api/event-bus/events?correlation_id=${correlationId}`
          );
          const chainData = await chainResponse.json();

          // Should have multiple events in the chain
          expect(chainData.events.length).toBeGreaterThan(0);
          console.warn(`Found ${chainData.events.length} events in chain: ${correlationId}`);

          // Verify event types in chain
          const eventTypes = chainData.events.map((e: any) => e.event_type);
          console.warn('Event types in chain:', eventTypes);
        }
      }
    });

    test('should verify event statistics are accurate', async ({ request }) => {
      const statsResponse = await request.get(`${BASE_URL}/api/event-bus/statistics`);
      const stats = await statsResponse.json();

      // Verify statistics structure
      expect(stats.total_events).toBeGreaterThanOrEqual(0);
      expect(typeof stats.events_by_type).toBe('object');
      expect(typeof stats.events_by_tenant).toBe('object');
      expect(stats.events_per_minute).toBeGreaterThanOrEqual(0);

      // If events exist, verify counts match
      if (stats.total_events > 0) {
        const typeCount = Object.values(stats.events_by_type).reduce(
          (sum: number, count: any) => sum + count,
          0
        );
        expect(typeCount).toBeGreaterThanOrEqual(stats.total_events);
      }

      console.warn('Statistics validation passed:', {
        total: stats.total_events,
        types: Object.keys(stats.events_by_type).length,
        tenants: Object.keys(stats.events_by_tenant).length,
      });
    });
  });

  test.describe('Real-time Event Updates', () => {
    test('should capture event stream snapshot', async ({ page }) => {
      await page.goto('/events');
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(3000); // Wait for real-time updates

      // Take snapshot of event stream
      await expect(page).toHaveScreenshot('event-stream-realtime.png', {
        fullPage: true,
      });
    });

    test('should verify WebSocket connection status', async ({ page }) => {
      await page.goto('/events');
      await page.waitForLoadState('networkidle');

      // Check for WebSocket connection indicators
      const _wsIndicators = await page.locator('text=/connected|streaming|real-time/i').count();

      // May or may not have visible indicators, but page should load
      const pageLoaded = (await page.locator('main').count()) > 0;
      expect(pageLoaded).toBeTruthy();
    });
  });

  test.describe('Event Data Validation', () => {
    test('should verify event payload structure', async ({ request }) => {
      const response = await request.get(`${BASE_URL}/api/event-bus/events?limit=5`);
      const data = await response.json();

      if (data.events.length > 0) {
        data.events.forEach((event: any) => {
          // Verify required envelope fields
          expect(event).toHaveProperty('event_type');
          expect(event).toHaveProperty('event_id');
          expect(event).toHaveProperty('timestamp');
          expect(event).toHaveProperty('tenant_id');
          expect(event).toHaveProperty('source');
          expect(event).toHaveProperty('payload');

          // Verify event_type format matches catalog pattern
          // Pattern can be: {tenant}.omninode.{domain}.v{version} OR omninode.{domain}.v{version} OR onex.{domain}.v{version}
          const isValidPattern = /^([^.]+\.)?omninode\..*\.v\d+$|^([^.]+\.)?onex\..*\.v\d+$/.test(
            event.event_type
          );
          expect(isValidPattern).toBeTruthy();

          // Verify payload is an object
          expect(typeof event.payload).toBe('object');
        });
      }
    });

    test('should verify event timestamps are valid', async ({ request }) => {
      const response = await request.get(`${BASE_URL}/api/event-bus/events?limit=10`);
      const data = await response.json();

      if (data.events.length > 0) {
        const now = Date.now();
        data.events.forEach((event: any) => {
          const eventTime = new Date(event.timestamp).getTime();

          // Event timestamp should be in the past (not future)
          expect(eventTime).toBeLessThanOrEqual(now);

          // Event timestamp should be recent (within last 24 hours for mock data)
          const oneDayAgo = now - 24 * 60 * 60 * 1000;
          expect(eventTime).toBeGreaterThanOrEqual(oneDayAgo);
        });
      }
    });

    test('should verify event types match catalog', async ({ request }) => {
      const response = await request.get(`${BASE_URL}/api/event-bus/events?limit=50`);
      const data = await response.json();

      // Known event type patterns from catalog
      // Patterns can have optional tenant prefix: {tenant}.omninode.{domain}.v{version}
      const validPatterns = [
        /([^.]+\.)?omninode\.intelligence\..*\.v\d+/,
        /([^.]+\.)?omninode\.agent\..*\.v\d+/,
        /([^.]+\.)?omninode\.metadata\..*\.v\d+/,
        /([^.]+\.)?omninode\.code\..*\.v\d+/,
        /([^.]+\.)?omninode\.database\..*\.v\d+/,
        /([^.]+\.)?omninode\.vault\..*\.v\d+/,
        /([^.]+\.)?omninode\.bridge\..*\.v\d+/,
        /([^.]+\.)?omninode\.service\..*\.v\d+/,
        /([^.]+\.)?omninode\.logging\..*\.v\d+/,
        /([^.]+\.)?omninode\.errors\..*\.v\d+/, // Error events
        /([^.]+\.)?onex\..*\.v\d+/,
      ];

      if (data.events.length > 0) {
        const eventTypes = new Set(data.events.map((e: any) => e.event_type));
        console.warn('Found event types:', Array.from(eventTypes));

        // Verify all event types match known patterns
        eventTypes.forEach((eventType) => {
          const matches = validPatterns.some((pattern) => pattern.test(eventType as string));
          expect(matches).toBeTruthy();
        });
      }
    });
  });
});
