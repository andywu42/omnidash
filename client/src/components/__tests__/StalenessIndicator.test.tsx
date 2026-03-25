/**
 * StalenessIndicator Component Tests (OMN-6397)
 *
 * Tests the shared utility functions and component rendering.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { StalenessIndicator } from '../StalenessIndicator';
import { getStaleSeverity, formatAge } from '@shared/staleness-types';

// ============================================================================
// Utility function tests (getStaleSeverity)
// ============================================================================

describe('getStaleSeverity', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-24T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "fresh" for timestamp < 1h ago', () => {
    const ts = new Date('2026-03-24T11:30:00Z').toISOString(); // 30min ago
    expect(getStaleSeverity(ts)).toBe('fresh');
  });

  it('returns "aging" for timestamp 1-6h ago', () => {
    const ts = new Date('2026-03-24T09:00:00Z').toISOString(); // 3h ago
    expect(getStaleSeverity(ts)).toBe('aging');
  });

  it('returns "stale" for timestamp 6-24h ago', () => {
    const ts = new Date('2026-03-24T00:00:00Z').toISOString(); // 12h ago
    expect(getStaleSeverity(ts)).toBe('stale');
  });

  it('returns "critical" for timestamp > 24h ago', () => {
    const ts = new Date('2026-03-22T12:00:00Z').toISOString(); // 2 days ago
    expect(getStaleSeverity(ts)).toBe('critical');
  });

  it('returns "critical" for null timestamp', () => {
    expect(getStaleSeverity(null)).toBe('critical');
  });

  it('returns "critical" for undefined timestamp', () => {
    expect(getStaleSeverity(undefined)).toBe('critical');
  });

  it('returns "fresh" for future timestamp', () => {
    const ts = new Date('2026-03-24T13:00:00Z').toISOString(); // 1h in future
    expect(getStaleSeverity(ts)).toBe('fresh');
  });
});

// ============================================================================
// Utility function tests (formatAge)
// ============================================================================

describe('formatAge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-24T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "Just now" for timestamp < 1 minute ago', () => {
    const ts = new Date('2026-03-24T11:59:30Z').toISOString();
    expect(formatAge(ts)).toBe('Just now');
  });

  it('returns minutes for timestamp < 1h ago', () => {
    const ts = new Date('2026-03-24T11:30:00Z').toISOString();
    expect(formatAge(ts)).toBe('30m ago');
  });

  it('returns hours for timestamp 1-24h ago', () => {
    const ts = new Date('2026-03-24T09:00:00Z').toISOString();
    expect(formatAge(ts)).toBe('3h ago');
  });

  it('returns days for timestamp > 24h ago', () => {
    const ts = new Date('2026-03-22T12:00:00Z').toISOString();
    expect(formatAge(ts)).toBe('2d ago');
  });

  it('returns "Never updated" for null', () => {
    expect(formatAge(null)).toBe('Never updated');
  });

  it('returns "Just now" for future timestamp', () => {
    const ts = new Date('2026-03-24T13:00:00Z').toISOString();
    expect(formatAge(ts)).toBe('Just now');
  });
});

// ============================================================================
// Component rendering tests
// ============================================================================

describe('StalenessIndicator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-24T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the age text', () => {
    const ts = new Date('2026-03-24T11:30:00Z').toISOString();
    render(<StalenessIndicator lastUpdated={ts} />);
    expect(screen.getByText('30m ago')).toBeInTheDocument();
  });

  it('renders with label prefix', () => {
    const ts = new Date('2026-03-24T11:30:00Z').toISOString();
    render(<StalenessIndicator lastUpdated={ts} label="Patterns" />);
    expect(screen.getByText('Patterns: 30m ago')).toBeInTheDocument();
  });

  it('renders "Never updated" for null timestamp', () => {
    render(<StalenessIndicator lastUpdated={null} />);
    expect(screen.getByText('Never updated')).toBeInTheDocument();
  });

  it('includes tooltip with exact timestamp', () => {
    const ts = new Date('2026-03-24T11:30:00Z').toISOString();
    const { container } = render(<StalenessIndicator lastUpdated={ts} />);
    const el = container.firstChild as HTMLElement;
    expect(el.title).toContain('Last updated:');
  });

  it('shows "No data received" tooltip for null timestamp', () => {
    const { container } = render(<StalenessIndicator lastUpdated={null} />);
    const el = container.firstChild as HTMLElement;
    expect(el.title).toContain('No data received');
  });
});
