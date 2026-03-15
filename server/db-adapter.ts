/**
 * PostgreSQL CRUD Adapter
 *
 * Provides full CRUD functionality for PostgreSQL tables using Drizzle ORM.
 * Supports both direct database access and event bus integration.
 *
 * Design:
 * - Direct access: Fast, synchronous queries for dashboard APIs
 * - All write-heavy or event-driven workloads are handled by the dedicated
 *   event-bus modules (event-bus-data-source.ts, event-consumer.ts,
 *   intelligence-event-adapter.ts), which emit diagnostics when their
 *   singletons are first accessed. This adapter performs direct database
 *   queries only and has no event-bus routing logic.
 *
 * Usage:
 *   const adapter = new PostgresAdapter();
 *   await adapter.connect();
 *
 *   // CRUD operations
 *   const rows = await adapter.query('agent_actions', { limit: 100 });
 *   const newRow = await adapter.insert('agent_actions', { agent_name: 'test', ... });
 *   const updated = await adapter.update('agent_actions', { id: '123' }, { status: 'completed' });
 *   await adapter.delete('agent_actions', { id: '123' });
 */

import { eq, and, gte, lte, desc, asc, sql, SQL, inArray } from 'drizzle-orm';
import { getIntelligenceDb } from './storage';
import * as schema from '@shared/intelligence-schema';
import { ensureNumeric } from '@shared/utils/number-utils';

export interface QueryOptions {
  limit?: number;
  offset?: number;
  orderBy?: { column: string; direction: 'asc' | 'desc' };
  where?: Record<string, any>;
  select?: string[]; // Specific columns to select
}

export interface InsertOptions {
  returning?: string[]; // Columns to return
}

export interface UpdateOptions {
  returning?: string[]; // Columns to return
}

export interface DeleteOptions {
  returning?: string[]; // Columns to return
}

/**
 * PostgreSQL CRUD Adapter
 *
 * Provides direct database access with Drizzle ORM. The constructor does not
 * log anything (it runs at module load time, before the server finishes
 * initializing). The event-bus modules (event-bus-data-source.ts,
 * event-consumer.ts, intelligence-event-adapter.ts) emit the appropriate
 * diagnostics when their singletons are first accessed. Missing KAFKA_BROKERS
 * is a misconfiguration error state, not normal operation. This adapter
 * continues serving direct database queries regardless.
 *
 * Note: `executeRaw()` was intentionally removed from this adapter because it
 * used `sql.raw()` with no parameter binding, creating a SQL injection risk.
 * All queries now go through Drizzle ORM's parameterized query builders
 * (`eq`, `inArray`, `gte`, `lte`, `sql\`...\``, etc.). See the inline comment
 * near the private helper methods section and the test file
 * `server/__tests__/db-adapter.test.ts` for full rationale and coverage.
 */
export class PostgresAdapter {
  private get db() {
    return getIntelligenceDb();
  }

  constructor() {
    // No logging here — dbAdapter is instantiated at module load time, so any
    // console output would fire before the server has finished initializing.
    // The event-bus modules (event-bus-data-source.ts, event-consumer.ts,
    // intelligence-event-adapter.ts) emit the appropriate error when their
    // singletons are first accessed.
  }

  /**
   * Connect to database (already connected via storage.ts, but kept for API consistency)
   */
  async connect(): Promise<void> {
    // Connection is managed by storage.ts's pool
    // This method exists for API consistency
  }

  /**
   * Query records from a table
   *
   * @param tableName - Table name (must exist in schema)
   * @param options - Query options (limit, offset, where, orderBy)
   * @returns Array of matching records
   */
  async query<T = any>(tableName: string, options: QueryOptions = {}): Promise<T[]> {
    const table = this.getTable(tableName);
    if (!table) {
      throw new Error(`Table ${tableName} not found in schema`);
    }

    let query = this.db.select().from(table);

    // Apply where conditions
    if (options.where) {
      const conditions = this.buildWhereConditions(table, options.where);
      if (conditions.length > 0) {
        query = query.where(and(...conditions)) as any;
      }
    }

    // Apply ordering
    if (options.orderBy) {
      const column = this.getColumn(table, options.orderBy.column);
      if (column) {
        query =
          options.orderBy.direction === 'desc'
            ? (query.orderBy(desc(column as any)) as any)
            : (query.orderBy(asc(column as any)) as any);
      }
    } else {
      // Default: order by created_at or id descending
      const createdAtCol = this.getColumn(table, 'created_at');
      const idCol = this.getColumn(table, 'id');
      if (createdAtCol) {
        query = query.orderBy(desc(createdAtCol as any)) as any;
      } else if (idCol) {
        query = query.orderBy(desc(idCol as any)) as any;
      }
    }

    // Apply limit/offset
    if (options.limit) {
      query = query.limit(options.limit) as any;
    }
    if (options.offset) {
      query = query.offset(options.offset) as any;
    }

    // Apply column selection
    if (options.select && options.select.length > 0) {
      const columns = options.select.map((col) => this.getColumn(table, col)).filter(Boolean);
      if (columns.length > 0) {
        query = this.db
          .select({
            ...columns.reduce((acc, col, i) => ({ ...acc, [options.select![i]]: col }), {}),
          })
          .from(table) as any;
      }
    }

    return (await query) as T[];
  }

  /**
   * Insert a new record
   *
   * @param tableName - Table name
   * @param data - Record data
   * @param options - Insert options (returning columns)
   * @returns Inserted record(s)
   */
  async insert<T = any>(
    tableName: string,
    data: Partial<T>,
    _options: InsertOptions = {}
  ): Promise<T | T[]> {
    const table = this.getTable(tableName);
    if (!table) {
      throw new Error(`Table ${tableName} not found in schema`);
    }

    // Add timestamps if columns exist (use camelCase for Drizzle schema properties)
    const now = new Date();
    if (this.hasColumn(table, 'createdAt')) {
      (data as any).createdAt = now;
    }
    if (this.hasColumn(table, 'updatedAt')) {
      (data as any).updatedAt = now;
    }

    const result = await this.db
      .insert(table)
      .values(data as any)
      .returning();
    const rows = Array.isArray(result) ? result : [];

    if (rows.length === 1) {
      return rows[0] as T;
    }
    return rows as T[];
  }

  /**
   * Update records matching conditions
   *
   * @param tableName - Table name
   * @param where - Where conditions
   * @param data - Update data
   * @param options - Update options (returning columns)
   * @returns Updated record(s)
   */
  async update<T = any>(
    tableName: string,
    where: Record<string, any>,
    data: Partial<T>,
    _options: UpdateOptions = {}
  ): Promise<T | T[]> {
    const table = this.getTable(tableName);
    if (!table) {
      throw new Error(`Table ${tableName} not found in schema`);
    }

    // Add updated_at timestamp if column exists (use camelCase for Drizzle schema properties)
    if (this.hasColumn(table, 'updatedAt')) {
      (data as any).updatedAt = new Date();
    }

    const conditions = this.buildWhereConditions(table, where);
    if (conditions.length === 0) {
      throw new Error('Update requires at least one where condition for safety');
    }

    const result = await this.db
      .update(table)
      .set(data as any)
      .where(and(...conditions))
      .returning();
    const rows = Array.isArray(result) ? result : [];

    if (rows.length === 1) {
      return rows[0] as T;
    }
    return rows as T[];
  }

  /**
   * Delete records matching conditions
   *
   * @param tableName - Table name
   * @param where - Where conditions
   * @param options - Delete options (returning columns)
   * @returns Deleted record(s)
   */
  async delete<T = any>(
    tableName: string,
    where: Record<string, any>,
    _options: DeleteOptions = {}
  ): Promise<T | T[]> {
    const table = this.getTable(tableName);
    if (!table) {
      throw new Error(`Table ${tableName} not found in schema`);
    }

    const conditions = this.buildWhereConditions(table, where);
    if (conditions.length === 0) {
      throw new Error('Delete requires at least one where condition for safety');
    }

    const result = await this.db
      .delete(table)
      .where(and(...conditions))
      .returning();
    const rows = Array.isArray(result) ? result : [];

    if (rows.length === 1) {
      return rows[0] as T;
    }
    return rows as T[];
  }

  /**
   * Upsert (insert or update) a record
   *
   * @param tableName - Table name
   * @param data - Record data
   * @param conflictColumns - Columns to check for conflicts (for ON CONFLICT)
   * @returns Upserted record
   */
  async upsert<T = any>(
    tableName: string,
    data: Partial<T>,
    conflictColumns: string[] = ['id']
  ): Promise<T> {
    const table = this.getTable(tableName);
    if (!table) {
      throw new Error(`Table ${tableName} not found in schema`);
    }

    // Add/update timestamps (use camelCase for Drizzle schema properties)
    const now = new Date();
    if (this.hasColumn(table, 'createdAt')) {
      (data as any).createdAt = (data as any).createdAt || now;
    }
    if (this.hasColumn(table, 'updatedAt')) {
      (data as any).updatedAt = now;
    }

    // Build conflict columns for ON CONFLICT clause
    const conflictCols = conflictColumns.map((col) => this.getColumn(table, col)).filter(Boolean);
    if (conflictCols.length === 0) {
      throw new Error(`Conflict columns not found in table ${tableName}`);
    }

    // Use Drizzle's onConflictDoUpdate
    const result = await this.db
      .insert(table)
      .values(data as any)
      .onConflictDoUpdate({
        target: conflictCols as any,
        set: { ...data, updatedAt: now } as any,
      })
      .returning();
    const rows = Array.isArray(result) ? result : [];

    return rows[0] as T;
  }

  /**
   * Count records matching conditions
   *
   * @param tableName - Table name
   * @param where - Where conditions (optional)
   * @returns Count of matching records
   */
  async count(tableName: string, where?: Record<string, any>): Promise<number> {
    const table = this.getTable(tableName);
    if (!table) {
      throw new Error(`Table ${tableName} not found in schema`);
    }

    // PostgreSQL returns count(*) as a bigint. The Neon serverless HTTP driver surfaces
    // bigint columns as text strings rather than JS numbers (to avoid precision loss from
    // Number's 53-bit integer limit). sql<string> tells Drizzle to type the result column
    // as `string` rather than incorrectly inferring `number`; ensureNumeric() then converts
    // the string to a JS number at runtime.
    let query = this.db.select({ count: sql<string>`count(*)` }).from(table);

    if (where) {
      const conditions = this.buildWhereConditions(table, where);
      if (conditions.length > 0) {
        query = query.where(and(...conditions)) as any;
      }
    }

    const result = await query;
    const count = result[0]?.count;
    return ensureNumeric('count', count, 0, { context: `count-query-${tableName}` });
  }

  // Helper methods

  // NOTE: executeRaw() was intentionally removed from this adapter.
  // It used sql.raw() with no parameter binding, which created a SQL injection risk —
  // any caller could pass arbitrary SQL strings and they would be executed verbatim.
  // Rather than attempt to sanitize raw SQL at the adapter layer (which is fragile),
  // the method was removed entirely. All queries now go through Drizzle ORM's
  // parameterized query builders (eq, inArray, gte, lte, sql`...`, etc.).
  // See server/__tests__/db-adapter.test.ts for the full rationale and test coverage.

  private getTable(tableName: string): any {
    // Map table names to schema exports
    const tableMap: Record<string, any> = {
      agent_routing_decisions: schema.agentRoutingDecisions,
      agent_actions: schema.agentActions,
      agent_manifest_injections: schema.agentManifestInjections,
      agent_transformation_events: schema.agentTransformationEvents,
      // 'error_events': schema.errorEvents, // TODO: Add errorEvents table to schema when needed
      pattern_lineage_nodes: schema.patternLineageNodes,
      pattern_lineage_edges: schema.patternLineageEdges,
      injection_effectiveness: schema.injectionEffectiveness,
      latency_breakdowns: schema.latencyBreakdowns,
      pattern_hit_rates: schema.patternHitRates,
      correlation_trace_spans: schema.correlationTraceSpans,
    };

    return tableMap[tableName];
  }

  private getColumn(table: any, columnName: string): any {
    if (!table || !table[columnName]) {
      return null;
    }
    return table[columnName];
  }

  private hasColumn(table: any, columnName: string): boolean {
    return !!this.getColumn(table, columnName);
  }

  private buildWhereConditions(table: any, where: Record<string, any>): SQL[] {
    const conditions: SQL[] = [];

    for (const [key, value] of Object.entries(where)) {
      const column = this.getColumn(table, key);
      if (!column) {
        console.warn(`[DataTransform] Column '${key}' not found in table, skipping condition`);
        continue;
      }

      // Handle different value types
      if (Array.isArray(value)) {
        // IN clause
        conditions.push(inArray(column as any, value));
      } else if (typeof value === 'object' && value !== null) {
        // Operators: { $gt: 10 }, { $gte: 10 }, { $lt: 10 }, { $lte: 10 }, { $ne: 10 }
        if ('$gt' in value) {
          conditions.push(sql`${column} > ${value.$gt}`);
        } else if ('$gte' in value) {
          conditions.push(gte(column as any, value.$gte));
        } else if ('$lt' in value) {
          conditions.push(sql`${column} < ${value.$lt}`);
        } else if ('$lte' in value) {
          conditions.push(lte(column as any, value.$lte));
        } else if ('$ne' in value) {
          conditions.push(sql`${column} != ${value.$ne}`);
        } else {
          // Object value: exact match
          conditions.push(eq(column as any, value));
        }
      } else {
        // Simple equality
        conditions.push(eq(column as any, value));
      }
    }

    return conditions;
  }
}

// Export singleton instance
export const dbAdapter = new PostgresAdapter();
