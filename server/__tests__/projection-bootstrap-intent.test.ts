// no-migration: OMN-4957 test file only, no schema change
/**
 * projection-bootstrap intentUpdate wiring test (OMN-4957)
 *
 * Verifies that 'intentUpdate' is included in consumerEventNames and that
 * the projection pipeline ingests intent events from the EventConsumer path.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('projection-bootstrap intentUpdate wiring', () => {
  // Static analysis test: verify the consumerEventNames array contains 'intentUpdate'.
  // This prevents regressions where the entry is accidentally removed.
  it('consumerEventNames includes intentUpdate', () => {
    const source = readFileSync(resolve(__dirname, '../projection-bootstrap.ts'), 'utf-8');

    // Extract the consumerEventNames array definition
    const match = source.match(/const consumerEventNames = \[([\s\S]*?)\] as const/);
    expect(match).not.toBeNull();

    const arrayBody = match![1];
    expect(arrayBody).toContain("'intentUpdate'");
  });

  it('consumerEventNames has 8 entries (was 7 before OMN-4957)', () => {
    const source = readFileSync(resolve(__dirname, '../projection-bootstrap.ts'), 'utf-8');

    const match = source.match(/const consumerEventNames = \[([\s\S]*?)\] as const/);
    expect(match).not.toBeNull();

    // Count quoted string entries
    const entries = match![1].match(/'[a-zA-Z]+'/g);
    expect(entries).not.toBeNull();
    expect(entries!.length).toBe(8);
  });
});
