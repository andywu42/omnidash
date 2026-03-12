/**
 * server/__tests__/startup-banner.test.ts
 *
 * Tests for the startup banner (OMN-4776).
 * Verifies bus mode announcement and mismatch detection.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('startup-banner', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalEnv = { ...process.env };
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  async function loadAndCallBanner() {
    const mod = await import('../../server/startup-banner.js');
    mod.printStartupBanner();
    return { consoleSpy, warnSpy };
  }

  // Test 1: LOCAL BUS
  it("logs 'LOCAL BUS' and 'localhost:19092' when on local bus", async () => {
    delete process.env.KAFKA_BROKERS;
    process.env.KAFKA_BOOTSTRAP_SERVERS = 'localhost:19092';
    process.env.OMNIDASH_BUS_MODE = 'local';
    const { consoleSpy: spy } = await loadAndCallBanner();
    const output = spy.mock.calls.flat().join('\n');
    expect(output).toContain('LOCAL BUS');
    expect(output).toContain('localhost:19092');
  });

  // Test 2: CLOUD BUS
  it("logs 'CLOUD BUS' and 'localhost:29092' when on cloud bus", async () => { // # cloud-bus-ok OMN-4776
    delete process.env.KAFKA_BROKERS;
    process.env.KAFKA_BOOTSTRAP_SERVERS = 'localhost:29092'; // # cloud-bus-ok OMN-4776
    process.env.OMNIDASH_BUS_MODE = 'cloud';
    const { consoleSpy: spy } = await loadAndCallBanner();
    const output = spy.mock.calls.flat().join('\n');
    expect(output).toContain('CLOUD BUS');
    expect(output).toContain('localhost:29092'); // # cloud-bus-ok OMN-4776
  });

  // Test 3: MISMATCH — port=29092 but mode=local # cloud-bus-ok OMN-4776
  it("logs 'MISMATCH' warning when broker port disagrees with OMNIDASH_BUS_MODE", async () => {
    delete process.env.KAFKA_BROKERS;
    process.env.KAFKA_BOOTSTRAP_SERVERS = 'localhost:29092'; // # cloud-bus-ok OMN-4776
    process.env.OMNIDASH_BUS_MODE = 'local'; // mismatch: port says cloud, mode says local
    await loadAndCallBanner();
    const warnOutput = warnSpy.mock.calls.flat().join('\n');
    const logOutput = consoleSpy.mock.calls.flat().join('\n');
    expect(warnOutput + logOutput).toContain('MISMATCH');
  });

  // Test 4: NOT CONFIGURED
  it("logs 'NOT CONFIGURED' when neither KAFKA_BOOTSTRAP_SERVERS nor KAFKA_BROKERS is set", async () => {
    delete process.env.KAFKA_BOOTSTRAP_SERVERS;
    delete process.env.KAFKA_BROKERS;
    delete process.env.OMNIDASH_BUS_MODE;
    const { consoleSpy: spy } = await loadAndCallBanner();
    const output = spy.mock.calls.flat().join('\n');
    expect(output).toContain('NOT CONFIGURED');
  });
});
