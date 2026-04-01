import { useEffect, useRef } from 'react';
import { useLocation } from 'wouter';
import { trackPageView } from '../lib/posthog';

/**
 * Track PostHog pageviews on Wouter route changes.
 * Place this hook once in a component that renders on every page (e.g., App).
 */
export function usePostHogPageview(): void {
  const [location] = useLocation();
  const prevLocation = useRef(location);

  useEffect(() => {
    // Only track if the path actually changed
    if (location !== prevLocation.current) {
      prevLocation.current = location;
      trackPageView(location);
    }
  }, [location]);

  // Track initial pageview on mount
  useEffect(() => {
    trackPageView(location);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
