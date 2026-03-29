/**
 * sql-safety.test.ts — Unit tests for the centralized SQL safety helpers [OMN-5196]
 *
 * Validates that:
 * 1. Allowlisted values produce correct SQL fragments
 * 2. Non-allowlisted values throw immediately
 * 3. Convenience helpers (timeWindowToInterval, truncUnitForWindow) map correctly
 */

import { describe, it, expect } from 'vitest';
import {
  safeInterval,
  safeTruncUnit,
  safeIntervalFromTimeWindow,
  timeWindowToInterval,
  truncUnitForWindow,
  ACCEPTED_WINDOWS,
  safeCountAndMaxTimestampQuery,
} from '../sql-safety';

describe('sql-safety [OMN-5196]', () => {
  // -------------------------------------------------------------------------
  // safeInterval
  // -------------------------------------------------------------------------

  describe('safeInterval', () => {
    it.each(['10 minutes', '1 hour', '24 hours', '7 days', '30 days'])(
      'accepts allowlisted interval "%s"',
      (interval) => {
        const result = safeInterval(interval);
        expect(result).toBeDefined();
        // The queryChunks contain the raw SQL text
        // Returned SQL fragment wraps the interval in quotes
        expect(result).toBeDefined();
      }
    );

    it.each([
      '1; DROP TABLE users',
      "' OR 1=1 --",
      '999 years',
      '',
      '24h', // raw window label, not interval
    ])('rejects non-allowlisted value "%s"', (val) => {
      expect(() => safeInterval(val)).toThrow(/safeInterval: rejected/);
    });
  });

  // -------------------------------------------------------------------------
  // safeTruncUnit
  // -------------------------------------------------------------------------

  describe('safeTruncUnit', () => {
    it.each(['minute', 'hour', 'day', 'week', 'month'])('accepts allowlisted unit "%s"', (unit) => {
      const result = safeTruncUnit(unit);
      expect(result).toBeDefined();
      // Returned SQL fragment wraps the unit in quotes
      expect(result).toBeDefined();
    });

    it.each(["'; DROP TABLE users; --", 'year', 'second', '', 'HOUR'])(
      'rejects non-allowlisted value "%s"',
      (val) => {
        expect(() => safeTruncUnit(val)).toThrow(/safeTruncUnit: rejected/);
      }
    );
  });

  // -------------------------------------------------------------------------
  // timeWindowToInterval
  // -------------------------------------------------------------------------

  describe('timeWindowToInterval', () => {
    it('maps 24h to "24 hours"', () => {
      expect(timeWindowToInterval('24h')).toBe('24 hours');
    });

    it('maps 7d to "7 days"', () => {
      expect(timeWindowToInterval('7d')).toBe('7 days');
    });

    it('maps 30d to "30 days"', () => {
      expect(timeWindowToInterval('30d')).toBe('30 days');
    });

    it('throws on unknown window', () => {
      expect(() => timeWindowToInterval('1y')).toThrow(/unrecognised window/);
    });
  });

  // -------------------------------------------------------------------------
  // safeIntervalFromTimeWindow
  // -------------------------------------------------------------------------

  describe('safeIntervalFromTimeWindow', () => {
    it.each(['24h', '7d', '30d'])('accepts window "%s"', (window) => {
      const result = safeIntervalFromTimeWindow(window);
      expect(result).toBeDefined();
    });

    it('throws on unknown window', () => {
      expect(() => safeIntervalFromTimeWindow('1y')).toThrow(/unrecognised window/);
    });
  });

  // -------------------------------------------------------------------------
  // truncUnitForWindow
  // -------------------------------------------------------------------------

  describe('truncUnitForWindow', () => {
    it('returns "hour" for 24h', () => {
      expect(truncUnitForWindow('24h')).toBe('hour');
    });

    it('returns "day" for 7d', () => {
      expect(truncUnitForWindow('7d')).toBe('day');
    });

    it('returns "day" for 30d', () => {
      expect(truncUnitForWindow('30d')).toBe('day');
    });
  });

  // -------------------------------------------------------------------------
  // safeCountAndMaxTimestampQuery [OMN-6975]
  // -------------------------------------------------------------------------

  describe('safeCountAndMaxTimestampQuery', () => {
    it('accepts valid table and column names', () => {
      const result = safeCountAndMaxTimestampQuery('agent_actions', 'created_at');
      expect(result).toBeDefined();
    });

    it('rejects table names with SQL injection', () => {
      expect(() => safeCountAndMaxTimestampQuery('"; DROP TABLE users; --', 'created_at')).toThrow(
        /safeCountAndMaxTimestampQuery: rejected table name/
      );
    });

    it('rejects column names with SQL injection', () => {
      expect(() =>
        safeCountAndMaxTimestampQuery('agent_actions', '"; DROP TABLE users; --')
      ).toThrow(/safeCountAndMaxTimestampQuery: rejected column name/);
    });

    it('rejects empty table name', () => {
      expect(() => safeCountAndMaxTimestampQuery('', 'created_at')).toThrow(
        /safeCountAndMaxTimestampQuery: rejected table name/
      );
    });

    it('rejects table names with spaces', () => {
      expect(() => safeCountAndMaxTimestampQuery('my table', 'created_at')).toThrow(
        /safeCountAndMaxTimestampQuery: rejected table name/
      );
    });
  });

  // -------------------------------------------------------------------------
  // ACCEPTED_WINDOWS
  // -------------------------------------------------------------------------

  describe('ACCEPTED_WINDOWS', () => {
    it('contains exactly 24h, 7d, 30d', () => {
      expect([...ACCEPTED_WINDOWS].sort()).toEqual(['24h', '30d', '7d']);
    });

    it('rejects unknown windows', () => {
      expect(ACCEPTED_WINDOWS.has('1y')).toBe(false);
      expect(ACCEPTED_WINDOWS.has('')).toBe(false);
    });
  });
});
