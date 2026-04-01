import { trackEvent } from './posthog';

/**
 * Standardized analytics events for omnidash.
 * All event names use snake_case per PostHog convention.
 */
export const Analytics = {
  /** User changes a time window filter (1h, 24h, 7d) */
  filterChanged: (filterName: string, value: string, page: string) =>
    trackEvent('filter_changed', { filter_name: filterName, value, page }),

  /** User refreshes data manually (not auto-poll) */
  manualRefresh: (page: string) =>
    trackEvent('manual_refresh', { page }),

  /** User toggles demo mode */
  demoModeToggled: (enabled: boolean) =>
    trackEvent('demo_mode_toggled', { enabled }),

  /** User opens sidebar navigation */
  sidebarNavigation: (destination: string) =>
    trackEvent('sidebar_navigation', { destination }),

  /** User toggles theme */
  themeToggled: (theme: string) =>
    trackEvent('theme_toggled', { theme }),

  /** Dashboard page encountered an error state */
  pageError: (page: string, error: string) =>
    trackEvent('page_error', { page, error: error.slice(0, 200) }),
} as const;
