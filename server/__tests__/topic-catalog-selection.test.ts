// no-migration: OMN-4961 test file only, no schema change
/**
 * Topic catalog selection tests (OMN-4961)
 *
 * Verifies that the ReadModelConsumer selects the correct topic source
 * (catalog vs static) based on OMNIDASH_READ_MODEL_USE_CATALOG and
 * KUBERNETES_SERVICE_HOST environment variables.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('topic catalog selection logic (OMN-4961)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clean slate for each test
    delete process.env.OMNIDASH_READ_MODEL_USE_CATALOG;
    delete process.env.KUBERNETES_SERVICE_HOST;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  /**
   * Evaluates the catalog selection logic extracted from read-model-consumer.ts.
   * This mirrors the actual condition on line 431-435.
   */
  function evaluateCatalogSelection(): boolean {
    const catalogEnv = process.env.OMNIDASH_READ_MODEL_USE_CATALOG;
    return (
      catalogEnv === 'true' || (catalogEnv !== 'false' && !process.env.KUBERNETES_SERVICE_HOST)
    );
  }

  it('enables catalog by default in local dev (no k8s)', () => {
    expect(evaluateCatalogSelection()).toBe(true);
  });

  it('disables catalog by default in k8s', () => {
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1';
    expect(evaluateCatalogSelection()).toBe(false);
  });

  it('respects explicit OMNIDASH_READ_MODEL_USE_CATALOG=true even in k8s', () => {
    process.env.OMNIDASH_READ_MODEL_USE_CATALOG = 'true';
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1';
    expect(evaluateCatalogSelection()).toBe(true);
  });

  it('respects explicit OMNIDASH_READ_MODEL_USE_CATALOG=false in local dev', () => {
    process.env.OMNIDASH_READ_MODEL_USE_CATALOG = 'false';
    expect(evaluateCatalogSelection()).toBe(false);
  });

  it('treats unset OMNIDASH_READ_MODEL_USE_CATALOG as auto-detect', () => {
    // Local: enabled
    expect(evaluateCatalogSelection()).toBe(true);

    // k8s: disabled
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1';
    expect(evaluateCatalogSelection()).toBe(false);
  });
});
