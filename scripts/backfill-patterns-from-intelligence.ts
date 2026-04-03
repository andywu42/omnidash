#!/usr/bin/env tsx
/* eslint-disable no-console */

/**
 * Backfill Patterns from Intelligence API (OMN-6395)
 *
 * Fetches patterns from the omniintelligence GET /api/v1/patterns endpoint
 * and upserts them into pattern_learning_artifacts in omnidash_analytics.
 * This recovers ~3,700 patterns whose Kafka events aged out of retention.
 *
 * Usage:
 *   npx tsx scripts/backfill-patterns-from-intelligence.ts
 *   npx tsx scripts/backfill-patterns-from-intelligence.ts --url http://localhost:8053
 *   npx tsx scripts/backfill-patterns-from-intelligence.ts --dry-run
 *
 * Environment:
 *   INTELLIGENCE_API_URL  - Intelligence API base URL (default: http://localhost:8053)
 *   OMNIDASH_ANALYTICS_DB_URL or POSTGRES_* - Database connection
 */

import { getIntelligenceDb } from '../server/storage';
import { patternLearningArtifacts } from '../shared/intelligence-schema';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_API_URL = process.env.INTELLIGENCE_API_URL || 'http://localhost:8053';
const PAGE_SIZE = 50;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

interface IntelligencePattern {
  id: string;
  pattern_signature: string;
  signature_hash: string;
  domain_id: string;
  quality_score: number | null;
  confidence: number;
  status: 'validated' | 'provisional';
  is_current: boolean;
  version: number;
  project_scope: string | null;
  created_at: string;
}

interface PatternPage {
  patterns: IntelligencePattern[];
  total_returned: number;
  limit: number;
  offset: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchWithRetry(url: string, retries: number = MAX_RETRIES): Promise<PatternPage> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      return (await res.json()) as PatternPage;
    } catch (err) {
      if (attempt === retries) throw err;
      console.warn(
        `[backfill] Attempt ${attempt}/${retries} failed: ${err instanceof Error ? err.message : err}. Retrying in ${RETRY_DELAY_MS}ms...`
      );
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
    }
  }
  throw new Error('Unreachable');
}

function mapToOmnidash(p: IntelligencePattern): Record<string, unknown> {
  return {
    patternId: p.id,
    patternName: p.pattern_signature.slice(0, 200), // Truncate for name field
    patternType: p.status === 'validated' ? 'validated' : 'provisional',
    language: null, // Not available from intelligence API
    lifecycleState: p.status,
    compositeScore: String(p.confidence),
    evidenceTier: p.quality_score !== null ? 'measured' : 'unmeasured',
    scoringEvidence: JSON.stringify({ confidence: p.confidence, quality_score: p.quality_score }),
    signature: JSON.stringify({ hash: p.signature_hash, text: p.pattern_signature }),
    metrics: JSON.stringify({}),
    metadata: JSON.stringify({
      backfilled: true,
      source: 'intelligence-api',
      domain_id: p.domain_id,
      version: p.version,
      project_scope: p.project_scope,
    }),
    createdAt: new Date(p.created_at),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const apiUrl = process.argv.includes('--url')
    ? process.argv[process.argv.indexOf('--url') + 1]
    : DEFAULT_API_URL;
  const dryRun = process.argv.includes('--dry-run');

  console.log(`[backfill] Intelligence API: ${apiUrl}`);
  console.log(`[backfill] Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);

  let offset = 0;
  let totalBackfilled = 0;
  let totalPages = 0;

  while (true) {
    const url = `${apiUrl}/api/v1/patterns?limit=${PAGE_SIZE}&offset=${offset}&min_confidence=0.0`;
    console.log(`[backfill] Fetching page ${totalPages + 1} (offset=${offset})...`);

    const page = await fetchWithRetry(url);

    if (page.patterns.length === 0) {
      console.log('[backfill] No more patterns to fetch');
      break;
    }

    if (!dryRun) {
      const db = getIntelligenceDb();

      for (const pattern of page.patterns) {
        const mapped = mapToOmnidash(pattern);
        try {
          await db
            .insert(patternLearningArtifacts)
            .values(mapped as any)
            .onConflictDoNothing();
        } catch (err) {
          // Log but continue -- don't stop on individual failures
          console.warn(
            `[backfill] Failed to upsert pattern ${pattern.id}: ${err instanceof Error ? err.message : err}`
          );
        }
      }
    }

    totalBackfilled += page.patterns.length;
    totalPages++;
    console.log(`[backfill] Backfilled ${totalBackfilled} patterns so far...`);

    // Check if this was the last page
    if (page.total_returned < page.limit) {
      break;
    }

    offset += PAGE_SIZE;
  }

  console.log(
    `[backfill] Complete. ${totalBackfilled} patterns ${dryRun ? 'would be' : ''} backfilled across ${totalPages} pages.`
  );
}

main().catch((err) => {
  console.error('[backfill] Fatal error:', err);
  process.exit(1);
});
