/**
 * ReviewCalibrationDashboard Component Tests (OMN-6177)
 *
 * Render-level tests for the Review Calibration dashboard.
 * Mocks fetch so assertions are deterministic with no network dependencies.
 *
 * Coverage:
 *  - Smoke test (renders without crashing)
 *  - Page heading and description
 *  - testid sentinel
 *  - Stat card labels
 *  - Section headings (charts, table, scores, few-shot log)
 *  - Empty state messages when no data
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { createTestLifecycle } from '@/tests/test-utils';

// ===========================
// Module Mocks
// ===========================

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: () => ({
    isConnected: false,
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  }),
}));

// Mock fetch to return empty data for all API endpoints
const mockFetch = vi.fn().mockImplementation((url: string) => {
  if (url.includes('/api/review-calibration/history')) {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve([]),
    });
  }
  if (url.includes('/api/review-calibration/scores')) {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve([]),
    });
  }
  if (url.includes('/api/review-calibration/fewshot-log')) {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(null),
    });
  }
  return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
});

// ===========================
// Test Helpers
// ===========================

let ReviewCalibrationDashboard: React.ComponentType;

// ===========================
// Test Suite
// ===========================

describe('ReviewCalibrationDashboard', () => {
  const lifecycle = createTestLifecycle();

  beforeEach(async () => {
    lifecycle.beforeEach();
    vi.stubGlobal('fetch', mockFetch);
    const mod = await import('../ReviewCalibrationDashboard');
    ReviewCalibrationDashboard = mod.default;
  });

  afterEach(async () => {
    await lifecycle.afterEach();
    vi.unstubAllGlobals();
  });

  // -----------------------------------------------
  // Smoke test
  // -----------------------------------------------

  it('renders without crashing', () => {
    lifecycle.render(<ReviewCalibrationDashboard />);
    expect(screen.getByTestId('page-review-calibration-dashboard')).toBeInTheDocument();
  });

  // -----------------------------------------------
  // Page header
  // -----------------------------------------------

  it('renders the page heading', () => {
    lifecycle.render(<ReviewCalibrationDashboard />);
    expect(screen.getByText('Review Calibration')).toBeInTheDocument();
  });

  it('renders the page description', () => {
    lifecycle.render(<ReviewCalibrationDashboard />);
    expect(
      screen.getByText(/Calibration loop metrics.*convergence.*noise trends.*model scores/i)
    ).toBeInTheDocument();
  });

  // -----------------------------------------------
  // Stat card labels
  // -----------------------------------------------

  it('renders the Total Runs stat card', async () => {
    lifecycle.render(<ReviewCalibrationDashboard />);
    await waitFor(() => {
      expect(screen.getByText('Total Runs')).toBeInTheDocument();
    });
  });

  it('renders the Latest F1 Score stat card', async () => {
    lifecycle.render(<ReviewCalibrationDashboard />);
    await waitFor(() => {
      expect(screen.getByText('Latest F1 Score')).toBeInTheDocument();
    });
  });

  it('renders the Latest Noise Ratio stat card', async () => {
    lifecycle.render(<ReviewCalibrationDashboard />);
    await waitFor(() => {
      expect(screen.getByText('Latest Noise Ratio')).toBeInTheDocument();
    });
  });

  it('renders the Models Scored stat card', async () => {
    lifecycle.render(<ReviewCalibrationDashboard />);
    await waitFor(() => {
      expect(screen.getByText('Models Scored')).toBeInTheDocument();
    });
  });

  // -----------------------------------------------
  // Section headings
  // -----------------------------------------------

  it('renders chart section headings', async () => {
    lifecycle.render(<ReviewCalibrationDashboard />);
    await waitFor(() => {
      expect(screen.getByText('Convergence Chart')).toBeInTheDocument();
      expect(screen.getByText('Noise Ratio Trend')).toBeInTheDocument();
    });
  });

  it('renders the Recent Calibration Runs table heading', async () => {
    lifecycle.render(<ReviewCalibrationDashboard />);
    await waitFor(() => {
      expect(screen.getByText('Recent Calibration Runs')).toBeInTheDocument();
    });
  });

  it('renders the Model Scores card heading', async () => {
    lifecycle.render(<ReviewCalibrationDashboard />);
    await waitFor(() => {
      expect(screen.getByText('Model Scores')).toBeInTheDocument();
    });
  });

  it('renders the Few-Shot Injection Log card heading', async () => {
    lifecycle.render(<ReviewCalibrationDashboard />);
    await waitFor(() => {
      expect(screen.getByText('Few-Shot Injection Log')).toBeInTheDocument();
    });
  });

  // -----------------------------------------------
  // Empty state
  // -----------------------------------------------

  it('shows empty state messages on empty data', async () => {
    lifecycle.render(<ReviewCalibrationDashboard />);
    await waitFor(() => {
      expect(screen.getByText('No calibration runs yet.')).toBeInTheDocument();
      expect(screen.getByText('No calibration runs recorded yet.')).toBeInTheDocument();
      expect(screen.getByText('No model scores available.')).toBeInTheDocument();
      expect(screen.getByText('No few-shot injection data available.')).toBeInTheDocument();
    });
  });

  // -----------------------------------------------
  // Category Heatmap placeholder
  // -----------------------------------------------

  it('renders the Category Heatmap placeholder', async () => {
    lifecycle.render(<ReviewCalibrationDashboard />);
    await waitFor(() => {
      expect(screen.getByText('Category Heatmap')).toBeInTheDocument();
    });
  });
});
