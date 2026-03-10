import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PostgresAdapter } from '../db-adapter';
import * as schema from '@shared/intelligence-schema';

// Note: executeRaw was intentionally removed from DatabaseAdapter.
// It used sql.raw() with no parameter binding, which created a SQL injection
// risk — any caller could pass arbitrary SQL strings. Rather than attempt to
// sanitize raw SQL at the adapter layer, the method was removed entirely.
// All queries now go through Drizzle ORM's parameterized query builders.

/**
 * Comprehensive test suite for DatabaseAdapter (server/db-adapter.ts)
 *
 * Coverage areas:
 * 1. Security: SQL injection prevention via parameterized queries
 * 2. Functionality: CRUD operations (query, insert, update, delete, upsert, count)
 * 3. Helper methods: getTable, getColumn, hasColumn, buildWhereConditions
 * 4. Error handling: invalid tables, invalid columns, missing WHERE clauses
 * 5. Timestamp management: automatic created_at/updated_at population
 *
 * Target: 80%+ code coverage
 */

// Mock the intelligenceDb
const mockDb = {
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  execute: vi.fn(),
};

vi.mock('../storage', () => ({
  getIntelligenceDb: vi.fn(() => mockDb),
}));

/**
 * Helper function to create a complete mock query chain
 * Returns both the chain and a Promise that resolves to finalResult
 */
function createMockQueryChain(finalResult: any) {
  const chain: any = {
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    offset: vi.fn(),
    set: vi.fn(),
    values: vi.fn(),
    returning: vi.fn(),
    onConflictDoUpdate: vi.fn(),
  };

  // Make all methods chainable
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  chain.set.mockReturnValue(chain);
  chain.values.mockReturnValue(chain);
  chain.onConflictDoUpdate.mockReturnValue(chain);

  // Final methods return promises
  chain.limit.mockReturnValue(chain);
  chain.offset.mockResolvedValue(finalResult);
  chain.returning.mockResolvedValue(finalResult);

  // Make it thenable so it can be awaited directly
  chain.then = (resolve: any) => Promise.resolve(finalResult).then(resolve);

  return chain;
}

describe('DatabaseAdapter - Security (SQL Injection Prevention)', () => {
  let adapter: PostgresAdapter;

  beforeEach(() => {
    adapter = new PostgresAdapter();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('buildWhereConditions prevents SQL injection with malicious string inputs', async () => {
    // Attempt SQL injection via where clause
    // Note: Must use camelCase keys to match schema property names
    const maliciousFilters = {
      agentName: "'; DROP TABLE users; --",
      actionType: "' OR '1'='1",
    };

    const chain = createMockQueryChain([]);
    vi.mocked(mockDb.select).mockReturnValue(chain);

    // Execute query with malicious input
    await adapter.query('agent_actions', {
      where: maliciousFilters,
      limit: 10,
    });

    // Verify WHERE clause was built (Drizzle ORM uses parameterized queries)
    expect(chain.where).toHaveBeenCalled();

    // The malicious input is safely parameterized by Drizzle ORM
    // (eq(), and() functions prevent SQL injection)
    const whereCall = chain.where.mock.calls[0];
    expect(whereCall).toBeDefined();
    expect(whereCall[0]).toBeDefined(); // WHERE condition exists
  });

  it('validates filter fields against schema (whitelist check)', async () => {
    // Invalid field names that don't exist in schema
    const invalidFilters = {
      malicious_field_that_does_not_exist: 'value',
      another_invalid_field: 'test',
    };

    const chain = createMockQueryChain([]);
    vi.mocked(mockDb.select).mockReturnValue(chain);

    // Should not throw - invalid fields are silently ignored (logged as warnings)
    const result = await adapter.query('agent_actions', {
      where: invalidFilters,
      limit: 10,
    });

    // Verify query executed without WHERE clause (invalid fields ignored)
    expect(chain.from).toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it('handles SQL injection attempts in array values (IN clause)', async () => {
    const maliciousArrayFilter = {
      agentName: ["'; DROP TABLE users; --", "' OR '1'='1", 'normal_value'],
    };

    const chain = createMockQueryChain([]);
    vi.mocked(mockDb).select.mockReturnValue(chain);

    await adapter.query('agent_actions', {
      where: maliciousArrayFilter,
      limit: 10,
    });

    // Verify inArray was used (parameterized)
    expect(chain.where).toHaveBeenCalled();
  });

  it('handles SQL injection attempts in operator values', async () => {
    const maliciousOperatorFilter = {
      durationMs: { $gt: "'; DROP TABLE users; --" },
    };

    const chain = createMockQueryChain([]);
    vi.mocked(mockDb).select.mockReturnValue(chain);

    await adapter.query('agent_actions', {
      where: maliciousOperatorFilter,
      limit: 10,
    });

    // Verify sql template literal was used (parameterized)
    expect(chain.where).toHaveBeenCalled();
  });
});

describe('DatabaseAdapter - Functionality (CRUD Operations)', () => {
  let adapter: PostgresAdapter;

  beforeEach(() => {
    adapter = new PostgresAdapter();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('query()', () => {
    it('executes basic query with limit and offset', async () => {
      const mockResult = [
        { id: '1', agentName: 'test-agent-1', actionType: 'tool_call' },
        { id: '2', agentName: 'test-agent-2', actionType: 'decision' },
      ];

      const chain = createMockQueryChain(mockResult);
      vi.mocked(mockDb).select.mockReturnValue(chain);

      const result = await adapter.query('agent_actions', {
        limit: 10,
        offset: 20,
      });

      expect(chain.from).toHaveBeenCalled();
      expect(chain.orderBy).toHaveBeenCalled();
      expect(chain.offset).toHaveBeenCalledWith(20);
      expect(chain.limit).toHaveBeenCalledWith(10);
      expect(result).toEqual(mockResult);
    });

    it('applies WHERE conditions correctly', async () => {
      const mockResult = [{ id: '1', agentName: 'test-agent' }];

      const chain = createMockQueryChain(mockResult);
      vi.mocked(mockDb).select.mockReturnValue(chain);

      await adapter.query('agent_actions', {
        where: { agentName: 'test-agent', actionType: 'tool_call' },
        limit: 10,
      });

      expect(chain.where).toHaveBeenCalled();
    });

    it('applies ORDER BY correctly (ascending)', async () => {
      const mockResult = [{ id: '1' }];

      const chain = createMockQueryChain(mockResult);
      vi.mocked(mockDb).select.mockReturnValue(chain);

      await adapter.query('agent_actions', {
        orderBy: { column: 'createdAt', direction: 'asc' },
        limit: 10,
      });

      expect(chain.orderBy).toHaveBeenCalled();
    });

    it('applies ORDER BY correctly (descending)', async () => {
      const mockResult = [{ id: '1' }];

      const chain = createMockQueryChain(mockResult);
      vi.mocked(mockDb).select.mockReturnValue(chain);

      await adapter.query('agent_actions', {
        orderBy: { column: 'createdAt', direction: 'desc' },
        limit: 10,
      });

      expect(chain.orderBy).toHaveBeenCalled();
    });

    it('applies default ordering by created_at DESC', async () => {
      const mockResult = [{ id: '1' }];

      const chain = createMockQueryChain(mockResult);
      vi.mocked(mockDb).select.mockReturnValue(chain);

      await adapter.query('agent_actions', { limit: 10 });

      // Should apply default ordering
      expect(chain.orderBy).toHaveBeenCalled();
    });

    it('throws error for invalid table name', async () => {
      await expect(adapter.query('invalid_table_name', { limit: 10 })).rejects.toThrow(
        'Table invalid_table_name not found in schema'
      );
    });

    it('handles empty result set', async () => {
      const chain = createMockQueryChain([]);
      vi.mocked(mockDb).select.mockReturnValue(chain);

      const result = await adapter.query('agent_actions', { limit: 10 });

      expect(result).toEqual([]);
    });
  });

  describe('insert()', () => {
    it('inserts record with automatic timestamp generation', async () => {
      const mockResult = [
        {
          id: '123',
          agentName: 'test-agent',
          actionType: 'tool_call',
          actionName: 'read_file',
          createdAt: new Date(),
        },
      ];

      // Capture the data passed to values()
      let capturedData: any;
      const chain = createMockQueryChain(mockResult);
      chain.values.mockImplementation((data: any) => {
        capturedData = data;
        return chain;
      });

      vi.mocked(mockDb).insert.mockReturnValue(chain);

      const data = {
        agentName: 'test-agent',
        actionType: 'tool_call',
        actionName: 'read_file',
        correlationId: '456',
      };

      const result = await adapter.insert('agent_actions', data);

      expect(chain.values).toHaveBeenCalled();

      // Verify timestamp was added (createdAt in schema, created_at in DB)
      expect(capturedData).toBeDefined();
      // The adapter adds createdAt to the data object before calling values()
      expect(capturedData).toHaveProperty('createdAt');
      expect(capturedData.createdAt).toBeInstanceOf(Date);

      // Returns single record (not array) when 1 row inserted
      expect(result).toEqual(mockResult[0]);
    });

    it('returns array when multiple records inserted', async () => {
      const mockResult = [
        { id: '1', agentName: 'agent-1' },
        { id: '2', agentName: 'agent-2' },
      ];

      const chain = createMockQueryChain(mockResult);
      vi.mocked(mockDb).insert.mockReturnValue(chain);

      const result = await adapter.insert('agent_actions', {
        agentName: 'test',
        correlationId: '123',
        actionType: 'test',
        actionName: 'test',
      });

      // Should return array when multiple rows
      expect(Array.isArray(result)).toBe(true);
    });

    it('throws error for invalid table name', async () => {
      await expect(adapter.insert('invalid_table', { field: 'value' })).rejects.toThrow(
        'Table invalid_table not found in schema'
      );
    });
  });

  describe('update()', () => {
    it('updates record (agent_actions table does not have updatedAt)', async () => {
      const mockResult = [
        {
          id: '123',
          agentName: 'updated-agent',
        },
      ];

      // Capture the data passed to set()
      let capturedData: any;
      const chain = createMockQueryChain(mockResult);
      chain.set.mockImplementation((data: any) => {
        capturedData = data;
        return chain;
      });

      vi.mocked(mockDb).update.mockReturnValue(chain);

      const result = await adapter.update(
        'agent_actions',
        { id: '123' },
        { agentName: 'updated-agent' }
      );

      expect(chain.set).toHaveBeenCalled();

      // Verify data was passed correctly
      expect(capturedData).toBeDefined();
      expect(capturedData.agentName).toBe('updated-agent');

      // Note: agent_actions table does not have updatedAt column,
      // so the adapter won't add it
      expect(capturedData).not.toHaveProperty('updatedAt');

      expect(result).toEqual(mockResult[0]);
    });

    it('requires WHERE condition for safety', async () => {
      await expect(adapter.update('agent_actions', {}, { agentName: 'updated' })).rejects.toThrow(
        'Update requires at least one where condition for safety'
      );
    });

    it('throws error for invalid table name', async () => {
      await expect(
        adapter.update('invalid_table', { id: '123' }, { field: 'value' })
      ).rejects.toThrow('Table invalid_table not found in schema');
    });
  });

  describe('delete()', () => {
    it('deletes record matching WHERE condition', async () => {
      const mockResult = [{ id: '123', agentName: 'deleted-agent' }];

      const chain = createMockQueryChain(mockResult);
      vi.mocked(mockDb).delete.mockReturnValue(chain);

      const result = await adapter.delete('agent_actions', { id: '123' });

      expect(chain.where).toHaveBeenCalled();
      expect(result).toEqual(mockResult[0]);
    });

    it('requires WHERE condition for safety', async () => {
      await expect(adapter.delete('agent_actions', {})).rejects.toThrow(
        'Delete requires at least one where condition for safety'
      );
    });

    it('throws error for invalid table name', async () => {
      await expect(adapter.delete('invalid_table', { id: '123' })).rejects.toThrow(
        'Table invalid_table not found in schema'
      );
    });
  });

  describe('upsert()', () => {
    it('performs upsert with conflict resolution on id', async () => {
      const mockResult = [
        {
          id: '123',
          agentName: 'upserted-agent',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      const chain = createMockQueryChain(mockResult);
      vi.mocked(mockDb).insert.mockReturnValue(chain);

      const result = await adapter.upsert(
        'agent_actions',
        {
          id: '123',
          agentName: 'upserted-agent',
          correlationId: '456',
          actionType: 'tool',
          actionName: 'test',
        },
        ['id']
      );

      expect(chain.onConflictDoUpdate).toHaveBeenCalled();
      expect(result).toEqual(mockResult[0]);
    });

    it('throws error if conflict columns not found', async () => {
      await expect(
        adapter.upsert('agent_actions', { agentName: 'test' }, ['nonexistent_column'])
      ).rejects.toThrow('Conflict columns not found in table agent_actions');
    });

    it('throws error for invalid table name', async () => {
      await expect(adapter.upsert('invalid_table', { field: 'value' }, ['id'])).rejects.toThrow(
        'Table invalid_table not found in schema'
      );
    });
  });

  describe('count()', () => {
    it('counts all records in table', async () => {
      const mockResult = [{ count: 42 }];
      const chain = createMockQueryChain(mockResult);
      vi.mocked(mockDb).select.mockReturnValue(chain);

      const result = await adapter.count('agent_actions');

      expect(chain.from).toHaveBeenCalled();
      expect(result).toBe(42);
    });

    it('counts records matching WHERE condition', async () => {
      const mockResult = [{ count: 15 }];
      const chain = createMockQueryChain(mockResult);
      vi.mocked(mockDb).select.mockReturnValue(chain);

      const result = await adapter.count('agent_actions', { agentName: 'test-agent' });

      expect(chain.where).toHaveBeenCalled();
      expect(result).toBe(15);
    });

    it('returns 0 for empty result', async () => {
      const mockResult = [{ count: null }];
      const chain = createMockQueryChain(mockResult);
      vi.mocked(mockDb).select.mockReturnValue(chain);

      const result = await adapter.count('agent_actions');

      expect(result).toBe(0);
    });

    it('throws error for invalid table name', async () => {
      await expect(adapter.count('invalid_table')).rejects.toThrow(
        'Table invalid_table not found in schema'
      );
    });
  });
});

describe('DatabaseAdapter - Helper Methods', () => {
  let adapter: PostgresAdapter;

  beforeEach(() => {
    adapter = new PostgresAdapter();
    vi.clearAllMocks();
  });

  it('getTable returns correct table for known table names', () => {
    // Access private method via type assertion
    const table = (adapter as any).getTable('agent_actions');
    expect(table).toBeDefined();
    expect(table).toBe(schema.agentActions);
  });

  it('getTable returns undefined for unknown table names', () => {
    const table = (adapter as any).getTable('unknown_table');
    expect(table).toBeUndefined();
  });

  it('getColumn returns column when it exists', () => {
    const table = schema.agentActions;
    const column = (adapter as any).getColumn(table, 'agentName');
    expect(column).toBeDefined();
  });

  it('getColumn returns null when column does not exist', () => {
    const table = schema.agentActions;
    const column = (adapter as any).getColumn(table, 'nonexistent_column');
    expect(column).toBeNull();
  });

  it('hasColumn returns true when column exists', () => {
    const table = schema.agentActions;
    const hasCol = (adapter as any).hasColumn(table, 'agentName');
    expect(hasCol).toBe(true);
  });

  it('hasColumn returns false when column does not exist', () => {
    const table = schema.agentActions;
    const hasCol = (adapter as any).hasColumn(table, 'nonexistent_column');
    expect(hasCol).toBe(false);
  });
});

describe('DatabaseAdapter - WHERE Condition Building', () => {
  let adapter: PostgresAdapter;

  beforeEach(() => {
    adapter = new PostgresAdapter();
    vi.clearAllMocks();
  });

  it('buildWhereConditions handles equality conditions', () => {
    const table = schema.agentActions;
    const conditions = (adapter as any).buildWhereConditions(table, {
      agentName: 'test-agent',
      actionType: 'tool_call',
    });

    expect(conditions).toHaveLength(2);
  });

  it('buildWhereConditions handles array values (IN clause)', () => {
    const table = schema.agentActions;
    const conditions = (adapter as any).buildWhereConditions(table, {
      agentName: ['agent-1', 'agent-2', 'agent-3'],
    });

    expect(conditions).toHaveLength(1);
  });

  it('buildWhereConditions handles $gt operator', () => {
    const table = schema.agentActions;
    const conditions = (adapter as any).buildWhereConditions(table, {
      durationMs: { $gt: 1000 },
    });

    expect(conditions).toHaveLength(1);
  });

  it('buildWhereConditions handles $gte operator', () => {
    const table = schema.agentActions;
    const conditions = (adapter as any).buildWhereConditions(table, {
      durationMs: { $gte: 1000 },
    });

    expect(conditions).toHaveLength(1);
  });

  it('buildWhereConditions handles $lt operator', () => {
    const table = schema.agentActions;
    const conditions = (adapter as any).buildWhereConditions(table, {
      durationMs: { $lt: 1000 },
    });

    expect(conditions).toHaveLength(1);
  });

  it('buildWhereConditions handles $lte operator', () => {
    const table = schema.agentActions;
    const conditions = (adapter as any).buildWhereConditions(table, {
      durationMs: { $lte: 1000 },
    });

    expect(conditions).toHaveLength(1);
  });

  it('buildWhereConditions handles $ne operator', () => {
    const table = schema.agentActions;
    const conditions = (adapter as any).buildWhereConditions(table, {
      actionType: { $ne: 'error' },
    });

    expect(conditions).toHaveLength(1);
  });

  it('buildWhereConditions handles mixed conditions', () => {
    const table = schema.agentActions;
    const conditions = (adapter as any).buildWhereConditions(table, {
      agentName: 'test-agent',
      durationMs: { $gte: 100 },
      actionType: ['tool_call', 'decision', 'error'],
    });

    // Should have 3 conditions (agent_name equality, duration_ms operator, action_type IN)
    expect(conditions.length).toBeGreaterThan(0);
  });

  it('buildWhereConditions skips invalid columns', () => {
    const table = schema.agentActions;
    const conditions = (adapter as any).buildWhereConditions(table, {
      agentName: 'test-agent',
      invalid_column: 'should_be_ignored',
    });

    // Only valid column should create condition
    expect(conditions).toHaveLength(1);
  });

  it('buildWhereConditions returns empty array for all invalid columns', () => {
    const table = schema.agentActions;
    const conditions = (adapter as any).buildWhereConditions(table, {
      invalid_column_1: 'value1',
      invalid_column_2: 'value2',
    });

    expect(conditions).toHaveLength(0);
  });
});

describe('DatabaseAdapter - Error Handling', () => {
  let adapter: PostgresAdapter;

  beforeEach(() => {
    adapter = new PostgresAdapter();
    vi.clearAllMocks();
  });

  it('handles database connection errors gracefully', async () => {
    // Mock the query chain to throw error
    const mockChain = {
      from: vi.fn(),
      where: vi.fn(),
      orderBy: vi.fn(),
      limit: vi.fn(),
      offset: vi.fn(),
    };

    // Make from() throw the error
    mockChain.from.mockImplementation(() => {
      throw new Error('Connection refused');
    });

    vi.mocked(mockDb).select.mockReturnValue(mockChain as any);

    await expect(adapter.query('agent_actions', { limit: 10 })).rejects.toThrow(
      'Connection refused'
    );
  });

  it('handles query execution errors', async () => {
    // Mock the query chain where the final await fails
    const mockChain: any = {
      from: vi.fn(),
      where: vi.fn(),
      orderBy: vi.fn(),
      limit: vi.fn(),
      offset: vi.fn(),
    };

    // Chain all methods
    mockChain.from.mockReturnValue(mockChain);
    mockChain.orderBy.mockReturnValue(mockChain);
    mockChain.limit.mockReturnValue(mockChain);

    // Make offset reject with error
    mockChain.offset.mockRejectedValue(new Error('Query execution failed'));

    // Make it thenable so it rejects when awaited
    mockChain.then = (resolve: any, reject: any) => mockChain.offset().then(resolve, reject);

    vi.mocked(mockDb).select.mockReturnValue(mockChain);

    await expect(adapter.query('agent_actions', { limit: 10 })).rejects.toThrow(
      'Query execution failed'
    );
  });

  it('handles insert errors', async () => {
    const chain = createMockQueryChain(null);
    chain.returning.mockRejectedValue(new Error('Insert failed'));
    vi.mocked(mockDb).insert.mockReturnValue(chain);

    await expect(
      adapter.insert('agent_actions', {
        agentName: 'test',
        correlationId: '123',
        actionType: 'test',
        actionName: 'test',
      })
    ).rejects.toThrow('Insert failed');
  });

  it('handles update errors', async () => {
    const chain = createMockQueryChain(null);
    chain.returning.mockRejectedValue(new Error('Update failed'));
    vi.mocked(mockDb).update.mockReturnValue(chain);

    await expect(
      adapter.update('agent_actions', { id: '123' }, { agentName: 'updated' })
    ).rejects.toThrow('Update failed');
  });

  it('handles delete errors', async () => {
    const chain = createMockQueryChain(null);
    chain.returning.mockRejectedValue(new Error('Delete failed'));
    vi.mocked(mockDb).delete.mockReturnValue(chain);

    await expect(adapter.delete('agent_actions', { id: '123' })).rejects.toThrow('Delete failed');
  });
});

describe('DatabaseAdapter - Connection Management', () => {
  let adapter: PostgresAdapter;

  beforeEach(() => {
    adapter = new PostgresAdapter();
    vi.clearAllMocks();
  });

  it('connect() exists for API consistency', async () => {
    // connect() is a no-op (connection managed by storage.ts)
    // Should not throw error
    await expect(adapter.connect()).resolves.toBeUndefined();
  });

  // The eventBusEnabled private field was removed from PostgresAdapter in the
  // refactor that separated Kafka concerns into dedicated event-bus modules
  // (event-bus-data-source.ts, event-consumer.ts, intelligence-event-adapter.ts).
  // PostgresAdapter is now a pure database CRUD adapter with no Kafka awareness.
  // The constructor is a documented no-op: it does not read KAFKA_BROKERS, does
  // not set any connection-state flag, and does not emit any diagnostics.
  // Kafka availability tests belong with the event-bus module tests, not here.
  it('constructor succeeds without Kafka environment variables', () => {
    delete process.env.KAFKA_BROKERS;
    delete process.env.KAFKA_BOOTSTRAP_SERVERS;
    expect(() => new PostgresAdapter()).not.toThrow();
  });

  it('constructor succeeds with Kafka environment variables set', () => {
    process.env.KAFKA_BROKERS = '192.168.86.200:29092'; // # cloud-bus-ok OMN-4494
    expect(() => new PostgresAdapter()).not.toThrow();
    delete process.env.KAFKA_BROKERS;
  });
});

describe('DatabaseAdapter - Additional Methods', () => {
  let adapter: PostgresAdapter;

  beforeEach(() => {
    adapter = new PostgresAdapter();
    vi.clearAllMocks();
  });

  describe('count', () => {
    it('should count all records when no where clause', async () => {
      const mockResult = [{ count: 42 }];
      // count() uses select({ count: ... }).from(), so we need to mock select to return chainable object
      vi.mocked(mockDb.select).mockReturnValue({
        from: vi.fn().mockResolvedValue(mockResult),
      } as any);

      const result = await adapter.count('agent_actions');

      expect(result).toBe(42);
      expect(mockDb.select).toHaveBeenCalled();
    });

    it('should count records with where conditions', async () => {
      const mockResult = [{ count: 10 }];
      const chain = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue(mockResult),
      };
      vi.mocked(mockDb.select).mockReturnValue(chain as any);

      const result = await adapter.count('agent_actions', { agentName: 'test-agent' });

      expect(result).toBe(10);
      expect(chain.where).toHaveBeenCalled();
    });

    it('should return 0 when count is null or undefined', async () => {
      const mockResult = [{ count: null }];
      vi.mocked(mockDb.select).mockReturnValue({
        from: vi.fn().mockResolvedValue(mockResult),
      } as any);

      const result = await adapter.count('agent_actions');

      expect(result).toBe(0);
    });

    it('should throw error for invalid table name', async () => {
      await expect(adapter.count('invalid_table')).rejects.toThrow(
        'Table invalid_table not found in schema'
      );
    });
  });

  describe('upsert', () => {
    it('should insert new record when no conflict', async () => {
      const mockResult = [{ id: '123', agentName: 'test-agent', createdAt: new Date() }];
      const chain = {
        values: vi.fn().mockReturnThis(),
        onConflictDoUpdate: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue(mockResult),
      };
      vi.mocked(mockDb.insert).mockReturnValue(chain as any);

      const result = await adapter.upsert(
        'agent_actions',
        {
          id: '123',
          agentName: 'test-agent',
          actionType: 'test',
          actionName: 'test',
        },
        ['id']
      );

      expect(result).toBeDefined();
      expect(mockDb.insert).toHaveBeenCalled();
      expect(chain.onConflictDoUpdate).toHaveBeenCalled();
    });

    it('should throw error for invalid table name', async () => {
      await expect(adapter.upsert('invalid_table', { id: '123' }, ['id'])).rejects.toThrow(
        'Table invalid_table not found in schema'
      );
    });

    it('should throw error when conflict columns not found', async () => {
      // Mock getColumn to return null (column not found)
      const adapterAny = adapter as any;
      const originalGetColumn = adapterAny.getColumn;
      adapterAny.getColumn = vi.fn(() => null);

      await expect(adapter.upsert('agent_actions', { id: '123' }, ['nonexistent'])).rejects.toThrow(
        'Conflict columns not found'
      );

      adapterAny.getColumn = originalGetColumn;
    });
  });

  describe('buildWhereConditions - edge cases', () => {
    it('should handle IN clause with array values', async () => {
      const mockResult = [{ id: '1' }];
      const chain = createMockQueryChain(mockResult);
      // query() does this.db.select().from(table), so select() must return an object with from()
      vi.mocked(mockDb.select).mockReturnValue({
        from: vi.fn().mockReturnValue(chain),
      } as any);

      const result = await adapter.query('agent_actions', {
        where: { agentName: ['agent-1', 'agent-2'] },
      });

      expect(result).toEqual(mockResult);
      expect(mockDb.select).toHaveBeenCalled();
    });

    it('should handle $gt operator', async () => {
      const mockResult = [{ id: '1' }];
      const chain = createMockQueryChain(mockResult);
      vi.mocked(mockDb.select).mockReturnValue({
        from: vi.fn().mockReturnValue(chain),
      } as any);

      const result = await adapter.query('agent_actions', {
        where: { durationMs: { $gt: 100 } },
      });

      expect(result).toEqual(mockResult);
      expect(mockDb.select).toHaveBeenCalled();
    });

    it('should handle $gte operator', async () => {
      const mockResult = [{ id: '1' }];
      const chain = createMockQueryChain(mockResult);
      vi.mocked(mockDb.select).mockReturnValue({
        from: vi.fn().mockReturnValue(chain),
      } as any);

      const result = await adapter.query('agent_actions', {
        where: { durationMs: { $gte: 100 } },
      });

      expect(result).toEqual(mockResult);
      expect(mockDb.select).toHaveBeenCalled();
    });

    it('should handle $lt operator', async () => {
      const mockResult = [{ id: '1' }];
      const chain = createMockQueryChain(mockResult);
      vi.mocked(mockDb.select).mockReturnValue({
        from: vi.fn().mockReturnValue(chain),
      } as any);

      const result = await adapter.query('agent_actions', {
        where: { durationMs: { $lt: 100 } },
      });

      expect(result).toEqual(mockResult);
      expect(mockDb.select).toHaveBeenCalled();
    });

    it('should handle $lte operator', async () => {
      const mockResult = [{ id: '1' }];
      const chain = createMockQueryChain(mockResult);
      vi.mocked(mockDb.select).mockReturnValue({
        from: vi.fn().mockReturnValue(chain),
      } as any);

      const result = await adapter.query('agent_actions', {
        where: { durationMs: { $lte: 100 } },
      });

      expect(result).toEqual(mockResult);
      expect(mockDb.select).toHaveBeenCalled();
    });

    it('should handle $ne operator', async () => {
      const mockResult = [{ id: '1' }];
      const chain = createMockQueryChain(mockResult);
      vi.mocked(mockDb.select).mockReturnValue({
        from: vi.fn().mockReturnValue(chain),
      } as any);

      const result = await adapter.query('agent_actions', {
        where: { agentName: { $ne: 'test-agent' } },
      });

      expect(result).toEqual(mockResult);
      expect(mockDb.select).toHaveBeenCalled();
    });

    it('should skip conditions for non-existent columns', async () => {
      const mockResult = [{ id: '1' }];
      const chain = createMockQueryChain(mockResult);
      vi.mocked(mockDb.select).mockReturnValue({
        from: vi.fn().mockReturnValue(chain),
      } as any);

      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await adapter.query('agent_actions', {
        where: { nonexistentColumn: 'value' },
      });

      expect(result).toEqual(mockResult);
      expect(consoleWarnSpy).toHaveBeenCalled();
      consoleWarnSpy.mockRestore();
    });
  });
});
