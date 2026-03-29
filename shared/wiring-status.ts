/**
 * Wiring status types and helpers for dashboard route pipeline status.
 *
 * The wiring-status.json manifest declares the pipeline status of each
 * dashboard route. The sidebar uses this to filter out pages that have
 * no data pipeline connected (status: stub/missing), show badges for
 * partial pages, and only display fully working pages by default.
 *
 * @see shared/wiring-status.json — the manifest
 * @see client/src/components/app-sidebar.tsx — sidebar filtering
 */

import wiringStatusData from './wiring-status.json';

/** Pipeline wiring status for a dashboard route. */
export type WiringStatus = 'working' | 'partial' | 'preview' | 'stub' | 'missing';

/** Metadata for a single route's wiring status. */
export interface WiringRouteEntry {
  status: WiringStatus;
  table: string | null;
  description: string;
}

/** The full wiring status manifest shape. */
export interface WiringStatusManifest {
  routes: Record<string, WiringRouteEntry>;
}

/** Loaded wiring status manifest (imported at build time). */
export const wiringStatus: WiringStatusManifest = wiringStatusData as WiringStatusManifest;

/**
 * Look up the wiring status for a given route.
 * Returns 'missing' if the route is not in the manifest.
 */
export function getRouteWiringStatus(route: string): WiringStatus {
  return wiringStatus.routes[route]?.status ?? 'missing';
}

/**
 * Check if a route should be visible in the sidebar.
 * Only 'working' and 'partial' routes are shown by default.
 */
export function isRouteVisible(route: string): boolean {
  const status = getRouteWiringStatus(route);
  return status === 'working' || status === 'partial';
}

/**
 * Get all routes with a given status.
 */
export function getRoutesByStatus(status: WiringStatus): string[] {
  return Object.entries(wiringStatus.routes)
    .filter(([, entry]) => entry.status === status)
    .map(([route]) => route);
}
