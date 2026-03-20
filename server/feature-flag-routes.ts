/**
 * Feature Flag BFF Routes (OMN-5581)
 *
 * Proxy routes to the registry API for feature flag management.
 * Degraded fallback: returns empty flag list when REGISTRY_API_URL is not configured.
 *
 * Routes:
 * - GET  /api/feature-flags           - List all feature flags
 * - PUT  /api/feature-flags/:flagName - Toggle a feature flag
 */

import { Router, type Request, type Response } from 'express';

const router = Router();

const REGISTRY_API_URL = process.env.REGISTRY_API_URL;

/**
 * Check whether the registry API is configured and reachable.
 * Returns the base URL if available, otherwise null.
 */
function getRegistryUrl(): string | null {
  if (!REGISTRY_API_URL) return null;
  return REGISTRY_API_URL.replace(/\/+$/, '');
}

// GET /api/feature-flags — proxy to registry API or return degraded response
router.get('/', async (_req: Request, res: Response) => {
  const registryUrl = getRegistryUrl();

  if (!registryUrl) {
    return res.json({
      flags: [],
      degraded: true,
      degraded_reason: 'REGISTRY_API_URL not configured',
    });
  }

  try {
    const upstream = await fetch(`${registryUrl}/registry/feature-flags`, {
      signal: AbortSignal.timeout(10_000),
    });

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => upstream.statusText);
      console.error(
        `[feature-flag-routes] Registry API returned ${upstream.status}: ${text}`
      );
      return res.json({
        flags: [],
        degraded: true,
        degraded_reason: `Registry API returned ${upstream.status}`,
      });
    }

    const data = await upstream.json();
    res.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[feature-flag-routes] Failed to reach registry API: ${message}`);
    res.json({
      flags: [],
      degraded: true,
      degraded_reason: `Registry API unreachable: ${message}`,
    });
  }
});

// PUT /api/feature-flags/:flagName — proxy toggle to registry API
router.put('/:flagName', async (req: Request, res: Response) => {
  const registryUrl = getRegistryUrl();

  if (!registryUrl) {
    return res.status(503).json({
      message: 'Toggle unavailable \u2014 registry API not configured',
    });
  }

  const { flagName } = req.params;

  try {
    const upstream = await fetch(
      `${registryUrl}/registry/feature-flags/${encodeURIComponent(flagName)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body),
        signal: AbortSignal.timeout(10_000),
      }
    );

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => upstream.statusText);
      return res.status(upstream.status).json({
        message: text,
      });
    }

    const data = await upstream.json();
    res.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[feature-flag-routes] Failed to toggle flag: ${message}`);
    res.status(503).json({
      message: `Registry API unreachable: ${message}`,
    });
  }
});

export default router;
