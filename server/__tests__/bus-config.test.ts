/**
 * server/__tests__/bus-config.test.ts
 *
 * Tests for the bus-config singleton (OMN-4771).
 * Verifies correct broker resolution precedence and bus mode detection.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Dynamic import used so we can re-import after env mutation in each test.
// Each test clears the module registry to force fresh resolution.

describe('bus-config', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // Helper: re-import the module with a clean module cache so each test
  // sees a fresh environment snapshot.
  async function loadBusConfig() {
    // Use a cache-busting query string via URL to force re-evaluation.
    // In vitest, dynamic import of the same path uses the module cache,
    // so we rely on the module NOT caching the env at module load time.
    // bus-config.ts reads process.env lazily (inside function calls), so
    // standard dynamic import is sufficient.
    const mod = await import('../../server/bus-config.js');
    return mod;
  }

  // Test 1: KAFKA_BOOTSTRAP_SERVERS alone
  it('returns KAFKA_BOOTSTRAP_SERVERS when set alone', async () => {
    delete process.env.KAFKA_BROKERS;
    process.env.KAFKA_BOOTSTRAP_SERVERS = 'localhost:19092';
    const { resolveBrokers } = await loadBusConfig();
    expect(resolveBrokers()).toEqual(['localhost:19092']);
  });

  // Test 2: KAFKA_BOOTSTRAP_SERVERS takes precedence over KAFKA_BROKERS
  it('KAFKA_BOOTSTRAP_SERVERS takes precedence over KAFKA_BROKERS', async () => {
    process.env.KAFKA_BOOTSTRAP_SERVERS = 'localhost:19092';
    process.env.KAFKA_BROKERS = 'localhost:29092'; // # cloud-bus-ok OMN-4771
    const { resolveBrokers } = await loadBusConfig();
    expect(resolveBrokers()).toEqual(['localhost:19092']);
  });

  // Test 3: Falls back to KAFKA_BROKERS when KAFKA_BOOTSTRAP_SERVERS is absent
  it('falls back to KAFKA_BROKERS when KAFKA_BOOTSTRAP_SERVERS is absent', async () => {
    delete process.env.KAFKA_BOOTSTRAP_SERVERS;
    process.env.KAFKA_BROKERS = 'localhost:29092'; // # cloud-bus-ok OMN-4771
    const { resolveBrokers } = await loadBusConfig();
    expect(resolveBrokers()).toEqual(['localhost:29092']); // # cloud-bus-ok OMN-4771
  });

  // Test 4: Supports comma-separated broker lists
  it('supports comma-separated broker lists', async () => {
    delete process.env.KAFKA_BROKERS;
    process.env.KAFKA_BOOTSTRAP_SERVERS = 'broker1:9092,broker2:9092,broker3:9092';
    const { resolveBrokers } = await loadBusConfig();
    expect(resolveBrokers()).toEqual(['broker1:9092', 'broker2:9092', 'broker3:9092']);
  });

  // Test 5: Throws when neither var is set
  it('throws when neither KAFKA_BOOTSTRAP_SERVERS nor KAFKA_BROKERS is set', async () => {
    delete process.env.KAFKA_BOOTSTRAP_SERVERS;
    delete process.env.KAFKA_BROKERS;
    const { resolveBrokers } = await loadBusConfig();
    expect(() => resolveBrokers()).toThrow('KAFKA_BOOTSTRAP_SERVERS');
  });

  // Test 6: getBusMode local
  it("getBusMode('localhost:19092') returns 'local'", async () => {
    const { getBusMode } = await loadBusConfig();
    expect(getBusMode('localhost:19092')).toBe('local');
  });

  // Test 7: getBusMode cloud
  it("getBusMode('localhost:29092') returns 'cloud'", async () => { // # cloud-bus-ok OMN-4771
    const { getBusMode } = await loadBusConfig();
    expect(getBusMode('localhost:29092')).toBe('cloud'); // # cloud-bus-ok OMN-4771
  });

  // Test 8: getBusMode unknown
  it("getBusMode('localhost:9092') returns 'unknown'", async () => {
    const { getBusMode } = await loadBusConfig();
    expect(getBusMode('localhost:9092')).toBe('unknown');
  });
});
