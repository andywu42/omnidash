import posthog from 'posthog-js';

const POSTHOG_API_KEY = import.meta.env.VITE_POSTHOG_API_KEY ?? '';
const POSTHOG_HOST = import.meta.env.VITE_POSTHOG_API_HOST ?? 'https://us.i.posthog.com';

/**
 * Initialize PostHog. No-op if API key is not configured.
 * This allows development without PostHog credentials.
 */
export function initPostHog(): void {
  if (!POSTHOG_API_KEY) {
    console.debug('[posthog] Skipped — VITE_POSTHOG_API_KEY not set');
    return;
  }

  posthog.init(POSTHOG_API_KEY, {
    api_host: POSTHOG_HOST,
    // Capture pageviews manually via our Wouter hook (not automatic)
    capture_pageview: false,
    // Capture pageleave for session duration
    capture_pageleave: true,
    // Respect Do Not Track
    respect_dnt: true,
    // Disable session recording for now (enable in Phase 2)
    disable_session_recording: true,
    // Persistence: localStorage (survives tab close)
    persistence: 'localStorage',
    // Load feature flags on init
    loaded: (ph) => {
      // In development, log all events to console
      if (import.meta.env.DEV) {
        ph.debug();
      }
    },
  });
}

/**
 * Track a pageview. Called by the route tracker hook.
 */
export function trackPageView(path: string): void {
  if (!POSTHOG_API_KEY) return;
  posthog.capture('$pageview', {
    $current_url: window.location.origin + path,
    path,
  });
}

/**
 * Track a custom event.
 */
export function trackEvent(event: string, properties?: Record<string, unknown>): void {
  if (!POSTHOG_API_KEY) return;
  posthog.capture(event, properties);
}

/**
 * Identify a user (call after auth).
 */
export function identifyUser(userId: string, traits?: Record<string, unknown>): void {
  if (!POSTHOG_API_KEY) return;
  posthog.identify(userId, traits);
}

export { posthog };
