// no-migration: OMN-6404 health verification script, no schema changes
/* eslint-disable no-console */
/**
 * Projection Health Verification Script (OMN-6404)
 *
 * Verifies that projection pipeline is healthy after replay:
 * 1. Queries GET /api/projection-health
 * 2. Checks that 40+ tables are populated
 * 3. Reports handler stats (drop rates)
 * 4. Reports consumer lag status
 * 5. Lists tables that remain empty
 *
 * Usage:
 *   npx tsx scripts/verify-projection-health.ts
 *   npx tsx scripts/verify-projection-health.ts --base-url http://localhost:3000
 */

const BASE_URL = process.argv.includes('--base-url')
  ? process.argv[process.argv.indexOf('--base-url') + 1]
  : 'http://localhost:3000';

interface TableHealth {
  rowCount: number;
  lastUpdated: string | null;
  stale: boolean;
  staleThresholdMinutes: number;
}

interface HandlerStats {
  received: number;
  projected: number;
  dropped: Record<string, number>;
}

interface ConsumerLag {
  groupId: string;
  totalLag: number;
  status: string;
  lastCheckedAt: string;
}

interface HealthResponse {
  tables: Record<string, TableHealth>;
  handlerStats: Record<string, HandlerStats>;
  consumerLag: ConsumerLag | null;
  summary: {
    totalTables: number;
    populatedTables: number;
    emptyTables: number;
    staleTables: number;
  };
  checkedAt: string;
}

async function main() {
  console.log(`\nProjection Health Verification`);
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Time: ${new Date().toISOString()}\n`);

  // 1. Fetch projection health
  let health: HealthResponse;
  try {
    const res = await fetch(`${BASE_URL}/api/projection-health`);
    if (!res.ok) {
      console.error(`ERROR: GET /api/projection-health returned HTTP ${res.status}`);
      process.exit(1);
    }
    health = (await res.json()) as HealthResponse;
  } catch (err) {
    console.error(`ERROR: Cannot reach ${BASE_URL}/api/projection-health`);
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // 2. Summary
  const { summary } = health;
  console.log(`--- Summary ---`);
  console.log(`  Total tables:     ${summary.totalTables}`);
  console.log(`  Populated:        ${summary.populatedTables}`);
  console.log(`  Empty:            ${summary.emptyTables}`);
  console.log(`  Stale:            ${summary.staleTables}`);
  console.log();

  // 3. Handler stats
  console.log(`--- Handler Stats ---`);
  for (const [name, stats] of Object.entries(health.handlerStats)) {
    const totalDropped = Object.values(stats.dropped).reduce((a, b) => a + b, 0);
    const dropRate =
      stats.received > 0 ? ((totalDropped / stats.received) * 100).toFixed(1) : '0.0';
    const yieldRate =
      stats.received > 0 ? ((stats.projected / stats.received) * 100).toFixed(1) : '0.0';
    console.log(`  ${name}:`);
    console.log(
      `    received=${stats.received}  projected=${stats.projected}  dropped=${totalDropped}  yield=${yieldRate}%  drop_rate=${dropRate}%`
    );
    if (totalDropped > 0) {
      for (const [reason, count] of Object.entries(stats.dropped)) {
        if (count > 0) {
          console.log(`      ${reason}: ${count}`);
        }
      }
    }
  }
  console.log();

  // 4. Consumer lag
  console.log(`--- Consumer Lag ---`);
  if (health.consumerLag) {
    const lag = health.consumerLag;
    console.log(`  Group:      ${lag.groupId}`);
    console.log(`  Total lag:  ${lag.totalLag.toLocaleString()}`);
    console.log(`  Status:     ${lag.status}`);
    console.log(`  Checked:    ${lag.lastCheckedAt}`);
  } else {
    console.log(`  No consumer lag data available (poller may not have run yet)`);
  }
  console.log();

  // 5. Empty tables
  const emptyTables = Object.entries(health.tables)
    .filter(([, t]) => t.rowCount === 0)
    .map(([name]) => name)
    .sort();

  if (emptyTables.length > 0) {
    console.log(`--- Empty Tables (${emptyTables.length}) ---`);
    for (const name of emptyTables) {
      console.log(`  - ${name}`);
    }
    console.log();
  }

  // 6. Populated tables with recent data
  const populatedStale = Object.entries(health.tables)
    .filter(([, t]) => t.rowCount > 0 && t.stale)
    .map(([name, t]) => ({ name, lastUpdated: t.lastUpdated, rowCount: t.rowCount }))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (populatedStale.length > 0) {
    console.log(`--- Populated but Stale (${populatedStale.length}) ---`);
    for (const t of populatedStale) {
      console.log(`  - ${t.name}: ${t.rowCount} rows, last updated ${t.lastUpdated ?? 'unknown'}`);
    }
    console.log();
  }

  // 7. Verdict
  console.log(`--- Verdict ---`);
  const passed = summary.populatedTables >= 40;
  if (passed) {
    console.log(`  PASS: ${summary.populatedTables} tables populated (target: >= 40)`);
  } else {
    console.log(`  FAIL: Only ${summary.populatedTables} tables populated (target: >= 40)`);
  }

  // Check handler yield
  let allHandlersHealthy = true;
  for (const [name, stats] of Object.entries(health.handlerStats)) {
    if (stats.received > 0) {
      const yieldRate = stats.projected / stats.received;
      if (yieldRate < 0.9) {
        console.log(`  WARN: ${name} yield is ${(yieldRate * 100).toFixed(1)}% (target: >= 90%)`);
        allHandlersHealthy = false;
      }
    }
  }
  if (allHandlersHealthy) {
    console.log(`  PASS: All handlers yield >= 90%`);
  }

  // Check consumer lag
  if (health.consumerLag && health.consumerLag.status !== 'healthy') {
    console.log(
      `  WARN: Consumer lag status is ${health.consumerLag.status} (${health.consumerLag.totalLag.toLocaleString()} events behind)`
    );
  } else if (health.consumerLag) {
    console.log(
      `  PASS: Consumer lag healthy (${health.consumerLag.totalLag.toLocaleString()} events behind)`
    );
  }

  console.log();
  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
