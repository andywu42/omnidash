/**
 * LlmRoutingDashboard Component Tests (OMN-2279)
 *
 * Render-level tests for the LLM Routing Effectiveness dashboard.
 * Mocks the llmRoutingSource singleton so all assertions are deterministic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { createTestLifecycle } from '../../tests/test-utils';

// ===========================
// Inline test data stubs (vi.hoisted so vi.mock can reference them)
// ===========================

const { stubSummary, stubLatency, stubByVersion, stubDisagreements, stubTrend } = vi.hoisted(
  () => ({
    stubSummary: {
      total_decisions: 500,
      agreement_rate: 0.703,
      disagreement_rate: 0.297,
      llm_p50_latency_ms: 45,
      fuzzy_p50_latency_ms: 12,
      fallback_rate: 0.05,
      avg_cost_per_decision: 0.0023,
    },
    stubLatency: [
      { method: 'llm', p50: 45, p95: 120, p99: 200 },
      { method: 'fuzzy', p50: 12, p95: 30, p99: 50 },
    ],
    stubByVersion: [
      { version: 'v1.2', agreement_rate: 0.72, total: 300 },
      { version: 'v1.1', agreement_rate: 0.68, total: 200 },
    ],
    stubDisagreements: [
      { llm_choice: 'claude', fuzzy_choice: 'gpt4', count: 15, sample_query: 'test' },
    ],
    stubTrend: [
      { date: '2026-03-28', agreement_rate: 0.7, total_decisions: 100 },
      { date: '2026-03-29', agreement_rate: 0.72, total_decisions: 120 },
    ],
  })
);

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

vi.mock('@/lib/data-sources/llm-routing-source', () => ({
  llmRoutingSource: {
    summary: vi.fn().mockResolvedValue(stubSummary),
    latency: vi.fn().mockResolvedValue(stubLatency),
    byVersion: vi.fn().mockResolvedValue(stubByVersion),
    disagreements: vi.fn().mockResolvedValue(stubDisagreements),
    trend: vi.fn().mockResolvedValue(stubTrend),
  },
}));

// ===========================
// Test Helpers
// ===========================

let LlmRoutingDashboard: React.ComponentType;

// ===========================
// Test Suite
// ===========================

describe('LlmRoutingDashboard', () => {
  const lifecycle = createTestLifecycle();

  beforeEach(async () => {
    lifecycle.beforeEach();
    const mod = await import('../LlmRoutingDashboard');
    LlmRoutingDashboard = mod.default;
  });

  afterEach(async () => {
    await lifecycle.afterEach();
  });

  it('renders without crashing', () => {
    lifecycle.render(<LlmRoutingDashboard />);
    expect(screen.getByTestId('page-llm-routing-dashboard')).toBeInTheDocument();
  });

  it('renders the page heading and sub-description', () => {
    lifecycle.render(<LlmRoutingDashboard />);
    expect(screen.getByText('LLM Routing Effectiveness')).toBeInTheDocument();
    expect(
      screen.getByText(/Comparing LLM routing vs fuzzy routing agreement, latency, and cost/i)
    ).toBeInTheDocument();
  });

  it('renders the 24h / 7d / 30d time window tabs', () => {
    lifecycle.render(<LlmRoutingDashboard />);
    expect(screen.getByRole('button', { name: '24h' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '7d' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '30d' })).toBeInTheDocument();
  });

  it('renders the Agreement Rate hero card label', async () => {
    lifecycle.render(<LlmRoutingDashboard />);
    await waitFor(() => {
      expect(screen.getByText('Agreement Rate')).toBeInTheDocument();
    });
  });

  it('renders the Total Decisions stat card label', async () => {
    lifecycle.render(<LlmRoutingDashboard />);
    await waitFor(() => {
      expect(screen.getByText('Total Decisions')).toBeInTheDocument();
    });
  });

  it('renders latency stat card labels', async () => {
    lifecycle.render(<LlmRoutingDashboard />);
    await waitFor(() => {
      expect(screen.getByText('LLM p50 Latency')).toBeInTheDocument();
      expect(screen.getByText('Fuzzy p50 Latency')).toBeInTheDocument();
    });
  });

  it('renders Fallback Rate and Avg Cost / Decision stat cards', async () => {
    lifecycle.render(<LlmRoutingDashboard />);
    await waitFor(() => {
      expect(screen.getByText('Fallback Rate')).toBeInTheDocument();
      expect(screen.getByText('Avg Cost / Decision')).toBeInTheDocument();
    });
  });

  it('renders the high disagreement alert when agreement_rate is below 0.6', async () => {
    const { llmRoutingSource } = await import('@/lib/data-sources/llm-routing-source');
    vi.mocked(llmRoutingSource.summary).mockResolvedValue({
      ...stubSummary,
      agreement_rate: 0.5,
    } as any);

    lifecycle.render(<LlmRoutingDashboard />);

    await waitFor(() => {
      expect(screen.getByText('High Disagreement Rate Detected')).toBeInTheDocument();
    });
  });

  it('does NOT render the high disagreement alert when agreement_rate is above 0.6', async () => {
    lifecycle.render(<LlmRoutingDashboard />);

    await waitFor(() => {
      expect(screen.getByText('Agreement Rate')).toBeInTheDocument();
    });

    expect(screen.queryByText('High Disagreement Rate Detected')).not.toBeInTheDocument();
  });

  it('renders the section headings for charts and disagreements table', async () => {
    lifecycle.render(<LlmRoutingDashboard />);
    await waitFor(() => {
      expect(screen.getByText('Routing Effectiveness Trends')).toBeInTheDocument();
      expect(screen.getByText('Latency Distribution')).toBeInTheDocument();
      expect(screen.getByText('Agreement Rate by Prompt Version')).toBeInTheDocument();
      expect(screen.getByText('Top Disagreement Pairs')).toBeInTheDocument();
    });
  });

  it('renders a Refresh button in the header', () => {
    lifecycle.render(<LlmRoutingDashboard />);
    expect(screen.getByRole('button', { name: /Refresh/i })).toBeInTheDocument();
  });
});
