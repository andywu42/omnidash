/**
 * Friction Log API Routes (OMN-8698)
 *
 * REST endpoints for the on-disk friction log:
 *   GET /api/friction  — all friction events, sorted by date desc
 *
 * Query params:
 *   limit=N          — cap results (default 50)
 *   surface=X        — filter by type or surface field
 *   since=ISO8601    — only events at or after this timestamp
 *
 * Reads YAML/JSON/MD files from FRICTION_LOG_PATH env var.
 * Default: /Users/jonah/.onex_state/friction (local dev) — override for .201 deploy.
 */

import { Router } from 'express';
import { readdirSync, readFileSync } from 'fs';
import { join, extname } from 'path';
import yaml from 'js-yaml';
import rateLimit from 'express-rate-limit';

// ============================================================================
// Rate Limiting
// ============================================================================

const _rawWindowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '', 10);
const windowMs = isNaN(_rawWindowMs) || _rawWindowMs <= 0 ? 60000 : _rawWindowMs;

const _rawMax = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS ?? '', 10);
const max = isNaN(_rawMax) || _rawMax <= 0 ? 100 : _rawMax;

const frictionRateLimiter = rateLimit({
  windowMs,
  max,
  standardHeaders: true,
  legacyHeaders: false,
});

// ============================================================================
// Router
// ============================================================================

const router = Router();

const DEFAULT_FRICTION_PATH = process.env.FRICTION_LOG_PATH ?? '/Users/jonah/.onex_state/friction';

interface FrictionEvent {
  id?: string;
  type?: string;
  surface?: string;
  severity?: string;
  timestamp?: string;
  date?: string;
  session?: string;
  context?: string;
  description?: string;
  failure_mode?: string;
  root_cause?: string;
  impact?: string;
  resolution?: string;
  recovery?: string;
  fix_direction?: string;
  ticket_id?: string;
  repos?: string[];
  ticket_needed?: boolean;
  suggested_title?: string;
  _filename: string;
  _effective_date: string;
}

function parseFrictionFile(filePath: string, filename: string): FrictionEvent | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const ext = extname(filename).toLowerCase();

    let parsed: Record<string, unknown> = {};

    if (ext === '.yaml' || ext === '.yml') {
      parsed = (yaml.load(content) as Record<string, unknown>) ?? {};
    } else if (ext === '.json') {
      parsed = JSON.parse(content) as Record<string, unknown>;
    } else if (ext === '.md') {
      // For markdown files, extract frontmatter if present, otherwise store raw description
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (fmMatch) {
        parsed = (yaml.load(fmMatch[1]) as Record<string, unknown>) ?? {};
      } else {
        // Extract first heading as description
        const headingMatch = content.match(/^#\s+(.+)/m);
        parsed = { description: headingMatch ? headingMatch[1] : content.slice(0, 200) };
      }
    } else {
      return null;
    }

    // Derive effective date: prefer timestamp/date field, fall back to filename prefix
    const tsField = (parsed['timestamp'] ?? parsed['date'] ?? '') as string;
    const filenameDate = filename.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? '';
    const effectiveDate = tsField || filenameDate || '';

    return {
      ...(parsed as Omit<FrictionEvent, '_filename' | '_effective_date'>),
      _filename: filename,
      _effective_date: effectiveDate,
    };
  } catch {
    return null;
  }
}

router.get('/', frictionRateLimiter, (req, res) => {
  const frictionPath = DEFAULT_FRICTION_PATH;
  const limit = Math.min(parseInt((req.query.limit as string) ?? '50', 10), 500);
  const surface = (req.query.surface as string) ?? '';
  const since = (req.query.since as string) ?? '';

  let files: string[];
  try {
    files = readdirSync(frictionPath);
  } catch {
    console.warn(`[friction] FRICTION_LOG_PATH not found: ${frictionPath}`);
    return res.json({ events: [], total: 0, warning: `Path not found: ${frictionPath}` });
  }

  const events: FrictionEvent[] = [];

  for (const filename of files) {
    const filePath = join(frictionPath, filename);
    const event = parseFrictionFile(filePath, filename);
    if (!event) continue;

    // Filter by surface/type
    if (surface) {
      const matchesSurface =
        (event.surface ?? '').toLowerCase().includes(surface.toLowerCase()) ||
        (event.type ?? '').toLowerCase().includes(surface.toLowerCase());
      if (!matchesSurface) continue;
    }

    // Filter by since
    if (since && event._effective_date) {
      if (event._effective_date < since) continue;
    }

    events.push(event);
  }

  // Sort by effective date desc
  events.sort((a, b) => {
    if (b._effective_date > a._effective_date) return 1;
    if (b._effective_date < a._effective_date) return -1;
    return 0;
  });

  const paged = events.slice(0, limit);

  return res.json({ events: paged, total: events.length });
});

export default router;
