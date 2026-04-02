/**
 * Integration Catalog API Routes
 *
 * REST endpoints for the /integrations dashboard page.
 * Reads the integration catalog from a static YAML definition
 * and performs live health checks against each integration's endpoint.
 *
 * Endpoints:
 *   GET /api/integrations         — Full catalog with cached health status
 *   GET /api/integrations/health  — Trigger fresh health checks and return results
 */

import { Router, type Request, type Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import * as net from 'net';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = Router();

// ============================================================================
// Types
// ============================================================================

interface HealthCheck {
  type: 'http' | 'tcp' | 'github_api';
  endpoint?: string;
  host?: string;
  port?: number;
}

interface CatalogIntegration {
  id: string;
  name: string;
  type: string;
  description: string;
  contract?: string;
  nodes?: string[];
  health_check?: HealthCheck;
  env_vars?: string[];
  topics?: string[];
}

interface CatalogYaml {
  name: string;
  description: string;
  catalog_version: { major: number; minor: number; patch: number };
  integrations: CatalogIntegration[];
}

interface IntegrationStatus {
  id: string;
  name: string;
  type: string;
  description: string;
  nodes: string[];
  envVars: string[];
  topics: string[];
  health: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  healthMessage: string;
  lastChecked: string | null;
}

// ============================================================================
// Catalog loader
// ============================================================================

let cachedCatalog: CatalogYaml | null = null;
let catalogLoadError: string | null = null;

function loadCatalog(): CatalogYaml | null {
  if (cachedCatalog) return cachedCatalog;

  // Look for the catalog YAML relative to common locations
  const candidates = [
    // When omnibase_infra is cloned alongside omnidash (omni_home layout)
    path.resolve(__dirname, '../..', 'omnibase_infra/src/omnibase_infra/contracts/integrations/catalog.yaml'),
    // Env-specified path
    process.env.INTEGRATION_CATALOG_PATH,
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        const raw = fs.readFileSync(candidate, 'utf-8');
        const parsed = yaml.load(raw) as CatalogYaml;
        if (!parsed || !Array.isArray(parsed.integrations) || !parsed.catalog_version) {
          catalogLoadError = `Invalid catalog structure in ${candidate}: missing integrations array or catalog_version`;
          continue;
        }
        cachedCatalog = parsed;
        catalogLoadError = null;
        return cachedCatalog;
      }
    } catch (err) {
      catalogLoadError = `Failed to load catalog from ${candidate}: ${err}`;
    }
  }

  catalogLoadError = 'Integration catalog YAML not found in any expected location';
  return null;
}

// ============================================================================
// Health check helpers
// ============================================================================

const HEALTH_TIMEOUT_MS = 3000;

/** Cached health results — refreshed on demand */
const healthCache = new Map<string, { health: IntegrationStatus['health']; message: string; at: string }>();
const CACHE_TTL_MS = 60_000; // 1 minute

async function checkHttpHealth(url: string): Promise<{ ok: boolean; message: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'User-Agent': 'omnidash-integration-catalog/1.0' },
    });
    clearTimeout(timer);
    if (res.ok) return { ok: true, message: `HTTP ${res.status}` };
    return { ok: false, message: `HTTP ${res.status} ${res.statusText}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('abort')) return { ok: false, message: 'Timeout' };
    return { ok: false, message: msg };
  }
}

async function checkTcpHealth(host: string, port: number): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, message: 'Timeout' });
    }, HEALTH_TIMEOUT_MS);

    socket.connect(port, host, () => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ ok: true, message: `TCP ${host}:${port} open` });
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ ok: false, message: err.message });
    });
  });
}

async function checkIntegrationHealth(
  integration: CatalogIntegration
): Promise<{ health: IntegrationStatus['health']; message: string }> {
  const hc = integration.health_check;
  if (!hc) return { health: 'unknown', message: 'No health check configured' };

  try {
    let result: { ok: boolean; message: string };

    switch (hc.type) {
      case 'http':
      case 'github_api':
        if (!hc.endpoint) return { health: 'unknown', message: 'No endpoint configured' };
        result = await checkHttpHealth(hc.endpoint);
        break;
      case 'tcp':
        if (!hc.host || !hc.port) return { health: 'unknown', message: 'No host/port configured' };
        result = await checkTcpHealth(hc.host, hc.port);
        break;
      default:
        return { health: 'unknown', message: `Unknown check type: ${hc.type}` };
    }

    return { health: result.ok ? 'healthy' : 'unhealthy', message: result.message };
  } catch (err) {
    return { health: 'unhealthy', message: err instanceof Error ? err.message : String(err) };
  }
}

async function getHealthWithCache(
  integration: CatalogIntegration,
  forceRefresh = false
): Promise<{ health: IntegrationStatus['health']; message: string; at: string }> {
  const cached = healthCache.get(integration.id);
  const now = Date.now();

  if (!forceRefresh && cached && now - new Date(cached.at).getTime() < CACHE_TTL_MS) {
    return cached;
  }

  const result = await checkIntegrationHealth(integration);
  const entry = { ...result, at: new Date().toISOString() };
  healthCache.set(integration.id, entry);
  return entry;
}

function toIntegrationStatus(
  integration: CatalogIntegration,
  healthResult: { health: IntegrationStatus['health']; message: string; at: string }
): IntegrationStatus {
  return {
    id: integration.id,
    name: integration.name,
    type: integration.type,
    description: integration.description,
    nodes: integration.nodes ?? [],
    envVars: integration.env_vars ?? [],
    topics: integration.topics ?? [],
    health: healthResult.health,
    healthMessage: healthResult.message,
    lastChecked: healthResult.at,
  };
}

// ============================================================================
// GET /api/integrations
// ============================================================================

router.get('/', async (_req: Request, res: Response) => {
  const catalog = loadCatalog();
  if (!catalog) {
    return res.status(503).json({
      error: catalogLoadError ?? 'Integration catalog not available',
      integrations: [],
    });
  }

  try {
    const results = await Promise.all(
      catalog.integrations.map(async (integration) => {
        const health = await getHealthWithCache(integration);
        return toIntegrationStatus(integration, health);
      })
    );

    return res.json({
      catalogVersion: `${catalog.catalog_version.major}.${catalog.catalog_version.minor}.${catalog.catalog_version.patch}`,
      integrations: results,
    });
  } catch (err) {
    console.error('[integrations] Error building catalog response:', err);
    return res.status(500).json({ error: 'Failed to fetch integration catalog' });
  }
});

// ============================================================================
// GET /api/integrations/health — Force refresh all health checks
// ============================================================================

router.get('/health', async (_req: Request, res: Response) => {
  const catalog = loadCatalog();
  if (!catalog) {
    return res.status(503).json({
      error: catalogLoadError ?? 'Integration catalog not available',
      integrations: [],
    });
  }

  try {
    const results = await Promise.all(
      catalog.integrations.map(async (integration) => {
        const health = await getHealthWithCache(integration, true);
        return toIntegrationStatus(integration, health);
      })
    );

    const healthy = results.filter((r) => r.health === 'healthy').length;
    const unhealthy = results.filter((r) => r.health === 'unhealthy').length;

    return res.json({
      summary: { total: results.length, healthy, unhealthy, unknown: results.length - healthy - unhealthy },
      integrations: results,
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[integrations] Error running health checks:', err);
    return res.status(500).json({ error: 'Failed to run integration health checks' });
  }
});

export default router;
