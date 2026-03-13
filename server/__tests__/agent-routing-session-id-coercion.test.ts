/**
 * Failing test for agent_routing_decisions session_id coercion (OMN-4820)
 *
 * Asserts that inserting a non-UUID session_id value into agent_routing_decisions
 * succeeds. Currently FAILS because the column is typed uuid and PostgreSQL
 * rejects non-UUID text values at INSERT time.
 *
 * Fix target: OMN-4821 (migrate session_id from uuid to text)
 * Sanitization: OMN-4823 (add sanitization at INSERT boundary)
 *
 * Related: OMN-4817 (epic), OMN-4818 (schema investigation)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { agentRoutingDecisions } from '../../shared/intelligence-schema';
import type { InsertAgentRoutingDecision } from '../../shared/intelligence-schema';
import { sql } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Test DB setup — uses the omnidash_analytics test database.
// If DB is unavailable, tests are skipped (not failed) to avoid blocking CI
// in environments without a local Postgres.
// ---------------------------------------------------------------------------

let pool: Pool | null = null;
let db: ReturnType<typeof drizzle> | null = null;
let dbAvailable = false;

beforeAll(async () => {
  // Build connection string from env vars — avoid hardcoded upstream port (Arch Guard).
  const connectionString =
    process.env.TEST_DATABASE_URL ||
    process.env.OMNIDASH_ANALYTICS_DATABASE_URL ||
    `postgresql://${process.env.POSTGRES_USER ?? 'postgres'}:${process.env.POSTGRES_PASSWORD ?? 'postgres'}@${process.env.POSTGRES_HOST ?? 'localhost'}:${process.env.POSTGRES_PORT ?? '5432'}/omnidash_analytics_test`;

  try {
    pool = new Pool({ connectionString, connectionTimeoutMillis: 2000 });
    db = drizzle(pool);
    // Verify connection
    await pool.query('SELECT 1');
    // Ensure migration 0001 has been applied (table exists)
    await pool.query(
      "SELECT 1 FROM information_schema.tables WHERE table_name = 'agent_routing_decisions'"
    );
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
});

afterAll(async () => {
  if (pool) {
    await pool.end();
  }
});

// ---------------------------------------------------------------------------
// Helper: build a minimal valid InsertAgentRoutingDecision row
// ---------------------------------------------------------------------------
function makeRow(overrides: Partial<InsertAgentRoutingDecision> = {}): InsertAgentRoutingDecision {
  return {
    correlationId: crypto.randomUUID(),
    selectedAgent: 'test-agent',
    confidenceScore: '0.9500',
    routingTimeMs: 42,
    routingStrategy: 'keyword',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Failing tests — RED until OMN-4821 migrates column to text
// ---------------------------------------------------------------------------

describe('agent_routing_decisions session_id coercion (OMN-4820)', () => {
  it('should INSERT successfully with a non-UUID session_id like "session-abc123"', async () => {
    if (!dbAvailable || !db) {
      console.warn('DB not available — skipping session_id coercion test');
      return;
    }

    const row = makeRow({ sessionId: 'session-abc123' });

    // CURRENTLY FAILS: PostgreSQL raises "invalid input syntax for type uuid"
    // because session_id column is typed uuid but "session-abc123" is not a UUID.
    // After OMN-4821 migrates column to text, this INSERT should succeed.
    await expect(
      db
        .insert(agentRoutingDecisions)
        .values(row)
        .onConflictDoNothing({ target: agentRoutingDecisions.correlationId })
    ).resolves.not.toThrow();
  });

  it('should INSERT successfully with an empty string session_id', async () => {
    if (!dbAvailable || !db) {
      console.warn('DB not available — skipping session_id empty string test');
      return;
    }

    // Empty string "" is falsy in JS so read-model-consumer maps it to undefined,
    // but future producers or direct DB writes could send empty strings.
    // After OMN-4821: column is text so empty string is valid (though OMN-4823
    // will sanitize it to null at the application layer).
    const row = makeRow({ sessionId: '' });

    await expect(
      db
        .insert(agentRoutingDecisions)
        .values(row)
        .onConflictDoNothing({ target: agentRoutingDecisions.correlationId })
    ).resolves.not.toThrow();
  });

  it('should INSERT successfully with a null session_id (already works)', async () => {
    if (!dbAvailable || !db) {
      console.warn('DB not available — skipping session_id null test');
      return;
    }

    // Null should always work since the column is nullable.
    // This test is GREEN even before OMN-4821 — it is a regression guard.
    const row = makeRow({ sessionId: undefined });

    await expect(
      db
        .insert(agentRoutingDecisions)
        .values(row)
        .onConflictDoNothing({ target: agentRoutingDecisions.correlationId })
    ).resolves.not.toThrow();
  });

  it('should INSERT successfully with a valid UUID session_id (regression guard)', async () => {
    if (!dbAvailable || !db) {
      console.warn('DB not available — skipping session_id UUID regression test');
      return;
    }

    // Valid UUIDs must continue to work after migration to text.
    const row = makeRow({ sessionId: crypto.randomUUID() });

    await expect(
      db
        .insert(agentRoutingDecisions)
        .values(row)
        .onConflictDoNothing({ target: agentRoutingDecisions.correlationId })
    ).resolves.not.toThrow();
  });

  it('the session_id column type should be text after OMN-4821 migration', async () => {
    if (!dbAvailable || !db) {
      console.warn('DB not available — skipping column type check');
      return;
    }

    const result = await pool!.query<{ data_type: string }>(`
      SELECT data_type
      FROM information_schema.columns
      WHERE table_name = 'agent_routing_decisions'
        AND column_name = 'session_id'
    `);

    const dataType = result.rows[0]?.data_type;

    // CURRENTLY FAILS: data_type is 'uuid', not 'text'.
    // After OMN-4821, this asserts the migration ran successfully.
    expect(dataType).toBe('text');
  });
});
