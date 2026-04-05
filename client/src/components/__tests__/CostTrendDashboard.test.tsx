/**
 * CostTrendDashboard Component Tests (OMN-2242)
 *
 * Basic rendering tests for the Cost Trend dashboard page.
 * Mocks the costSource and WebSocket hook to test component behavior
 * with deterministic data.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { createTestLifecycle } from '../../tests/test-utils';
import type {
  CostSummary,
  CostTrendPoint,
  CostByModel,
  CostByRepo,
  CostByPattern,
  TokenUsagePoint,
  BudgetAlert,
} from '@shared/cost-types';

// ===========================
// Inline Test Fixtures
// ===========================

const fixtureSummary: CostSummary = {
  total_cost_usd: 87.15,
  reported_cost_usd: 71.46,
  estimated_cost_usd: 15.69,
  reported_coverage_pct: 82.0,
  total_tokens: 1_736_000,
  prompt_tokens: 1_302_000,
  completion_tokens: 434_000,
  session_count: 238,
  model_count: 5,
  avg_cost_per_session: 0.3662,
  cost_change_pct: -8.3,
  active_alerts: 1,
};

const fixtureTrend: CostTrendPoint[] = [
  {
    timestamp: '2025-01-09',
    total_cost_usd: 11.8,
    reported_cost_usd: 9.2,
    estimated_cost_usd: 2.6,
    session_count: 5,
  },
  {
    timestamp: '2025-01-10',
    total_cost_usd: 13.3,
    reported_cost_usd: 10.8,
    estimated_cost_usd: 2.5,
    session_count: 6,
  },
];

const fixtureByModel: CostByModel[] = [
  {
    model_name: 'claude-3-opus',
    total_cost_usd: 28.5,
    reported_cost_usd: 28.5,
    estimated_cost_usd: 0,
    total_tokens: 42_000,
    prompt_tokens: 30_240,
    completion_tokens: 11_760,
    request_count: 17,
    usage_source: 'API',
  },
];

const fixtureByRepo: CostByRepo[] = [
  {
    repo_name: 'repo-orchestrator',
    total_cost_usd: 22.4,
    reported_cost_usd: 22.4,
    estimated_cost_usd: 0,
    total_tokens: 145_000,
    session_count: 48,
    usage_source: 'API',
  },
];

const fixtureByPattern: CostByPattern[] = [
  {
    pattern_id: 'pat-0001',
    pattern_name: 'Error Retry with Backoff',
    total_cost_usd: 8.4,
    reported_cost_usd: 8.4,
    estimated_cost_usd: 0,
    prompt_tokens: 48_216,
    completion_tokens: 20_664,
    injection_count: 145,
    avg_cost_per_injection: 0.0579,
    usage_source: 'API',
  },
];

const fixtureTokenUsage: TokenUsagePoint[] = [
  {
    timestamp: '2025-01-09',
    prompt_tokens: 24_000,
    completion_tokens: 8_000,
    total_tokens: 32_000,
    usage_source: 'API',
  },
  {
    timestamp: '2025-01-10',
    prompt_tokens: 26_000,
    completion_tokens: 9_000,
    total_tokens: 35_000,
    usage_source: 'API',
  },
];

const fixtureAlerts: BudgetAlert[] = [
  {
    id: 'alert-001',
    name: 'Daily Spend Limit',
    threshold_usd: 25.0,
    period: 'daily',
    current_spend_usd: 18.42,
    utilization_pct: 73.7,
    is_triggered: false,
    last_evaluated: '2025-01-15T12:00:00.000Z',
  },
  {
    id: 'alert-002',
    name: 'Weekly Budget',
    threshold_usd: 150.0,
    period: 'weekly',
    current_spend_usd: 162.8,
    utilization_pct: 108.5,
    is_triggered: true,
    last_evaluated: '2025-01-15T12:00:00.000Z',
  },
  {
    id: 'alert-003',
    name: 'Monthly Cap',
    threshold_usd: 500.0,
    period: 'monthly',
    current_spend_usd: 287.6,
    utilization_pct: 57.5,
    is_triggered: false,
    last_evaluated: '2025-01-15T12:00:00.000Z',
  },
];

// ===========================
// Module Mocks
// ===========================

// Mock the WebSocket hook to prevent real connections
vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: () => ({
    isConnected: false,
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  }),
}));

// Mock the costSource to return deterministic data without network calls
vi.mock('@/lib/data-sources/cost-source', () => ({
  costSource: {
    summary: vi.fn().mockResolvedValue(fixtureSummary),
    trend: vi.fn().mockResolvedValue(fixtureTrend),
    byModel: vi.fn().mockResolvedValue(fixtureByModel),
    byRepo: vi.fn().mockResolvedValue(fixtureByRepo),
    byPattern: vi.fn().mockResolvedValue(fixtureByPattern),
    tokenUsage: vi.fn().mockResolvedValue(fixtureTokenUsage),
    alerts: vi.fn().mockResolvedValue(fixtureAlerts),
  },
}));

// ===========================
// Tests
// ===========================

// Lazily import to allow mocks to take effect
let CostTrendDashboard: React.ComponentType;

describe('CostTrendDashboard', () => {
  const lifecycle = createTestLifecycle();

  beforeEach(async () => {
    lifecycle.beforeEach();
    const mod = await import('../../pages/CostTrendDashboard');
    CostTrendDashboard = mod.default;
  });

  afterEach(async () => {
    await lifecycle.afterEach();
  });

  it('renders the page heading and description', async () => {
    lifecycle.render(<CostTrendDashboard />);

    expect(screen.getByText('Cost Trends')).toBeInTheDocument();
    expect(
      screen.getByText(
        'LLM cost and token usage trends with drill-down by model, repo, and pattern'
      )
    ).toBeInTheDocument();
  });

  it('renders the page container with test id', async () => {
    lifecycle.render(<CostTrendDashboard />);

    expect(screen.getByTestId('page-cost-trends')).toBeInTheDocument();
  });

  it('renders the time window selector buttons', async () => {
    lifecycle.render(<CostTrendDashboard />);

    expect(screen.getByText('24h')).toBeInTheDocument();
    expect(screen.getByText('7d')).toBeInTheDocument();
    expect(screen.getByText('30d')).toBeInTheDocument();
  });

  it('renders the hero metric with total spend after loading', async () => {
    lifecycle.render(<CostTrendDashboard />);

    await waitFor(() => {
      // The fixture summary returns total_cost_usd = 87.15
      expect(screen.getByText(/Total Spend/)).toBeInTheDocument();
    });
  });

  it('renders metric card labels', async () => {
    lifecycle.render(<CostTrendDashboard />);

    await waitFor(() => {
      expect(screen.getByText('Cost Change')).toBeInTheDocument();
      expect(screen.getByText('Avg Cost/Session')).toBeInTheDocument();
      expect(screen.getByText('Total Tokens')).toBeInTheDocument();
      // "Budget Alerts" appears both as metric card label and section heading
      expect(screen.getAllByText('Budget Alerts').length).toBeGreaterThanOrEqual(2);
    });
  });

  it('renders chart section headings', async () => {
    lifecycle.render(<CostTrendDashboard />);

    await waitFor(() => {
      expect(screen.getByText(/Cost Over Time/)).toBeInTheDocument();
      expect(screen.getByText(/Token Usage/)).toBeInTheDocument();
      expect(screen.getByText('Cost by Model')).toBeInTheDocument();
      expect(screen.getByText('Cost by Repo')).toBeInTheDocument();
      expect(screen.getByText('Cost by Pattern')).toBeInTheDocument();
    });
  });

  it('renders the budget alerts section heading', async () => {
    lifecycle.render(<CostTrendDashboard />);

    // Budget Alerts appears both as a section heading and as a metric card label.
    // The section heading uses h3.
    await waitFor(() => {
      const headings = screen.getAllByText('Budget Alerts');
      expect(headings.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders the include-estimated toggle', async () => {
    lifecycle.render(<CostTrendDashboard />);

    expect(screen.getByText('Include estimated')).toBeInTheDocument();
  });

  it('shows triggered alert count from fixture data', async () => {
    lifecycle.render(<CostTrendDashboard />);

    // Fixture alerts have 1 triggered alert ("Weekly Budget").
    // The metric card value shows "1 triggered" and the badge shows "1 triggered"
    await waitFor(() => {
      const triggered = screen.getAllByText(/1 triggered/);
      expect(triggered.length).toBeGreaterThanOrEqual(1);
    });
  });
});
