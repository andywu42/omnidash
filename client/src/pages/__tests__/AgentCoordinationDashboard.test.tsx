import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import type { ReactNode } from 'react';
import AgentCoordinationDashboard from '@/pages/AgentCoordinationDashboard';

const mockFetch = vi.fn();
global.fetch = mockFetch;

let queryClient: QueryClient | null = null;

function renderWithClient(ui: ReactNode) {
  queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchInterval: false,
        refetchOnWindowFocus: false,
        gcTime: Infinity,
        staleTime: Infinity,
      },
    },
  });
  const result = render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
  return { queryClient, ...result };
}

describe('AgentCoordinationDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  afterEach(async () => {
    if (queryClient) {
      queryClient.clear();
      await queryClient.cancelQueries();
      queryClient = null;
    }
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('renders page title and populated data', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        recent: [
          {
            event_id: 'evt-1',
            correlation_id: 'corr-1',
            task_id: 'task-123',
            event_type: 'task-assigned',
            dispatch_surface: 'team_worker',
            agent_model: 'claude-opus-4-6',
            status: null,
            payload: null,
            emitted_at: new Date().toISOString(),
          },
          {
            event_id: 'evt-2',
            correlation_id: 'corr-1',
            task_id: 'task-123',
            event_type: 'task-completed',
            dispatch_surface: 'local_llm',
            agent_model: 'qwen3-14b',
            status: 'PASS',
            payload: null,
            emitted_at: new Date().toISOString(),
          },
        ],
        summary: {
          total_events: 2,
          surface_counts: { team_worker: 1, local_llm: 1 },
          event_type_counts: { 'task-assigned': 1, 'task-completed': 1 },
        },
      }),
    });

    const result = renderWithClient(<AgentCoordinationDashboard />);

    expect(screen.getByText('Agent Coordination')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByTestId('agent-coordination-page')).toBeInTheDocument();
    });

    // Summary card shows total
    await waitFor(() => {
      expect(screen.getByText('2')).toBeInTheDocument();
    });

    // Events should show task IDs (appears in both rows)
    expect(screen.getAllByText('task-123').length).toBeGreaterThanOrEqual(1);

    // Surface badges should render (appear in both summary cards and table rows)
    expect(screen.getAllByText('Team Worker').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Local LLM').length).toBeGreaterThanOrEqual(1);

    // Model names should appear
    expect(screen.getByText('claude-opus-4-6')).toBeInTheDocument();
    expect(screen.getByText('qwen3-14b')).toBeInTheDocument();

    result.unmount();
  });

  it('shows empty state when no events', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        recent: [],
        summary: { total_events: 0, surface_counts: {}, event_type_counts: {} },
      }),
    });

    const result = renderWithClient(<AgentCoordinationDashboard />);

    await waitFor(() => {
      expect(screen.getByText('No team events yet')).toBeInTheDocument();
    });

    result.unmount();
  });

  it('shows error state on fetch failure', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
    });

    const result = renderWithClient(<AgentCoordinationDashboard />);

    await waitFor(() => {
      expect(screen.getByText(/Failed to load agent coordination data/)).toBeInTheDocument();
    });

    result.unmount();
  });
});
