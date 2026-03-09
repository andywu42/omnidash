/**
 * Tests for the centralized health status mapping utility
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeHealthStatus,
  getHealthLabel,
  getHealthColor,
  getHealthTextClass,
  getHealthBgClass,
  getHealthBadgeClass,
  isHealthy,
  isCritical,
  isWarning,
  sortByHealthSeverity,
  type SemanticHealthLevel,
} from '../health-utils';

describe('health-utils', () => {
  describe('normalizeHealthStatus', () => {
    describe('healthy mappings', () => {
      it.each([
        ['passing', 'healthy'],
        ['healthy', 'healthy'],
        ['up', 'healthy'],
        ['online', 'healthy'],
        ['ok', 'healthy'],
        ['good', 'healthy'],
        ['active', 'healthy'],
        ['PASSING', 'healthy'], // case insensitive
        ['Healthy', 'healthy'],
        ['  up  ', 'healthy'], // whitespace handling
      ])('should map "%s" to "%s"', (input, expected) => {
        expect(normalizeHealthStatus(input)).toBe(expected);
      });
    });

    describe('warning mappings', () => {
      it.each([
        ['warning', 'warning'],
        ['degraded', 'warning'],
        ['slow', 'warning'],
        ['warn', 'warning'],
        ['caution', 'warning'],
        ['impaired', 'warning'],
        ['WARNING', 'warning'], // case insensitive
        ['Degraded', 'warning'],
      ])('should map "%s" to "%s"', (input, expected) => {
        expect(normalizeHealthStatus(input)).toBe(expected);
      });
    });

    describe('critical mappings', () => {
      it.each([
        ['critical', 'critical'],
        ['unhealthy', 'critical'],
        ['dead', 'critical'],
        ['down', 'critical'],
        ['failed', 'critical'],
        ['error', 'critical'],
        ['failing', 'critical'],
        ['offline', 'critical'],
        ['unavailable', 'critical'],
        ['CRITICAL', 'critical'], // case insensitive
        ['Unhealthy', 'critical'],
      ])('should map "%s" to "%s"', (input, expected) => {
        expect(normalizeHealthStatus(input)).toBe(expected);
      });
    });

    describe('unknown fallback', () => {
      it.each([
        ['unknown', 'unknown'],
        ['', 'unknown'],
        ['random', 'unknown'],
        ['pending', 'unknown'],
        ['initializing', 'unknown'],
      ])('should map "%s" to "unknown"', (input, expected) => {
        expect(normalizeHealthStatus(input)).toBe(expected);
      });

      it('should handle null input', () => {
        expect(normalizeHealthStatus(null)).toBe('unknown');
      });

      it('should handle undefined input', () => {
        expect(normalizeHealthStatus(undefined)).toBe('unknown');
      });
    });
  });

  describe('getHealthLabel', () => {
    it.each([
      ['healthy', 'Healthy'],
      ['warning', 'Warning'],
      ['critical', 'Critical'],
      ['unknown', 'Unknown'],
    ] as [SemanticHealthLevel, string][])('should return "%s" for "%s"', (status, expected) => {
      expect(getHealthLabel(status)).toBe(expected);
    });
  });

  describe('getHealthColor', () => {
    it.each([
      ['healthy', 'green'],
      ['warning', 'yellow'],
      ['critical', 'red'],
      ['unknown', 'gray'],
    ] as [SemanticHealthLevel, string][])('should return "%s" for "%s"', (status, expected) => {
      expect(getHealthColor(status)).toBe(expected);
    });
  });

  describe('getHealthTextClass', () => {
    it.each([
      ['healthy', 'text-green-500'],
      ['warning', 'text-yellow-500'],
      ['critical', 'text-red-500'],
      ['unknown', 'text-gray-500'],
    ] as [SemanticHealthLevel, string][])('should return "%s" for "%s"', (status, expected) => {
      expect(getHealthTextClass(status)).toBe(expected);
    });
  });

  describe('getHealthBgClass', () => {
    it.each([
      ['healthy', 'bg-green-500'],
      ['warning', 'bg-yellow-500'],
      ['critical', 'bg-red-500'],
      ['unknown', 'bg-gray-500'],
    ] as [SemanticHealthLevel, string][])('should return "%s" for "%s"', (status, expected) => {
      expect(getHealthBgClass(status)).toBe(expected);
    });
  });

  describe('getHealthBadgeClass', () => {
    it('should return badge classes for healthy status', () => {
      const result = getHealthBadgeClass('healthy');
      expect(result).toContain('bg-green-500/10');
      expect(result).toContain('text-green-500');
      expect(result).toContain('border-green-500/20');
    });

    it('should return badge classes for warning status', () => {
      const result = getHealthBadgeClass('warning');
      expect(result).toContain('bg-yellow-500/10');
      expect(result).toContain('text-yellow-500');
    });

    it('should return badge classes for critical status', () => {
      const result = getHealthBadgeClass('critical');
      expect(result).toContain('bg-red-500/10');
      expect(result).toContain('text-red-500');
    });

    it('should return badge classes for unknown status', () => {
      const result = getHealthBadgeClass('unknown');
      expect(result).toContain('bg-gray-500/10');
      expect(result).toContain('text-gray-500');
    });
  });

  describe('isHealthy', () => {
    it('should return true for healthy statuses', () => {
      expect(isHealthy('passing')).toBe(true);
      expect(isHealthy('healthy')).toBe(true);
      expect(isHealthy('up')).toBe(true);
      expect(isHealthy('online')).toBe(true);
    });

    it('should return false for non-healthy statuses', () => {
      expect(isHealthy('warning')).toBe(false);
      expect(isHealthy('critical')).toBe(false);
      expect(isHealthy('unknown')).toBe(false);
      expect(isHealthy(null)).toBe(false);
    });
  });

  describe('isCritical', () => {
    it('should return true for critical statuses', () => {
      expect(isCritical('critical')).toBe(true);
      expect(isCritical('unhealthy')).toBe(true);
      expect(isCritical('dead')).toBe(true);
      expect(isCritical('down')).toBe(true);
      expect(isCritical('failed')).toBe(true);
    });

    it('should return false for non-critical statuses', () => {
      expect(isCritical('healthy')).toBe(false);
      expect(isCritical('warning')).toBe(false);
      expect(isCritical('unknown')).toBe(false);
    });
  });

  describe('isWarning', () => {
    it('should return true for warning statuses', () => {
      expect(isWarning('warning')).toBe(true);
      expect(isWarning('degraded')).toBe(true);
      expect(isWarning('slow')).toBe(true);
    });

    it('should return false for non-warning statuses', () => {
      expect(isWarning('healthy')).toBe(false);
      expect(isWarning('critical')).toBe(false);
      expect(isWarning('unknown')).toBe(false);
    });
  });

  describe('sortByHealthSeverity', () => {
    interface TestItem {
      name: string;
      status: string;
    }

    it('should sort items by severity (critical first)', () => {
      const items: TestItem[] = [
        { name: 'A', status: 'healthy' },
        { name: 'B', status: 'critical' },
        { name: 'C', status: 'warning' },
        { name: 'D', status: 'unknown' },
      ];

      const sorted = sortByHealthSeverity(items, (item) => item.status);

      expect(sorted.map((i) => i.name)).toEqual(['B', 'C', 'A', 'D']);
    });

    it('should handle various status strings', () => {
      const items: TestItem[] = [
        { name: 'A', status: 'passing' }, // healthy
        { name: 'B', status: 'unhealthy' }, // critical
        { name: 'C', status: 'degraded' }, // warning
        { name: 'D', status: 'random' }, // unknown
      ];

      const sorted = sortByHealthSeverity(items, (item) => item.status);

      expect(sorted.map((i) => i.name)).toEqual(['B', 'C', 'A', 'D']);
    });

    it('should not mutate the original array', () => {
      const items: TestItem[] = [
        { name: 'A', status: 'healthy' },
        { name: 'B', status: 'critical' },
      ];

      const sorted = sortByHealthSeverity(items, (item) => item.status);

      expect(items[0].name).toBe('A'); // Original unchanged
      expect(sorted[0].name).toBe('B'); // Sorted has critical first
    });

    it('should handle empty arrays', () => {
      const items: TestItem[] = [];
      const sorted = sortByHealthSeverity(items, (item) => item.status);
      expect(sorted).toEqual([]);
    });

    it('should handle null/undefined statuses', () => {
      const items = [
        { name: 'A', status: null as string | null },
        { name: 'B', status: 'critical' },
        { name: 'C', status: undefined as string | undefined },
      ];

      const sorted = sortByHealthSeverity(items, (item) => item.status);

      expect(sorted.map((i) => i.name)).toEqual(['B', 'A', 'C']);
    });
  });
});
