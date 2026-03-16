/**
 * Build Info Routes (OMN-5143)
 *
 * Exposes GET /api/build-info — returns version, git SHA, build time, and
 * uptime so the dashboard-sweep freshness pre-check can verify the running
 * omnidash instance reflects the latest deploy.
 *
 * Response shape:
 * {
 *   version: string;      // from package.json
 *   gitSha: string;       // HEAD commit at build/startup time
 *   buildTime: string;    // ISO timestamp of server startup
 *   uptimeSeconds: number; // process uptime
 *   nodeEnv: string;      // NODE_ENV
 * }
 *
 * Registered BEFORE the requireAuth gate so unauthenticated callers
 * (lifecycle scripts, k8s probes) can reach it.
 */

import { Router } from 'express';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

// Capture at module load time (once per server start)
const BUILD_TIME = new Date().toISOString();

function getGitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', {
      encoding: 'utf-8',
      timeout: 3000,
    }).trim();
  } catch {
    return 'unknown';
  }
}

function getPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8'));
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

const GIT_SHA = getGitSha();
const PACKAGE_VERSION = getPackageVersion();

const router = Router();

router.get('/', (_req, res) => {
  res.json({
    version: PACKAGE_VERSION,
    gitSha: GIT_SHA,
    buildTime: BUILD_TIME,
    uptimeSeconds: Math.floor(process.uptime()),
    nodeEnv: process.env.NODE_ENV ?? 'unknown',
  });
});

export default router;
