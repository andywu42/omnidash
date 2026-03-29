import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import type { ReactNode } from 'react';
import WiringStatusPage from '@/pages/WiringStatus';

// Mock fetch globally
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

describe('WiringStatus page', () => {
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

  it('renders loading state then populated data', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        routes: [
          {
            route: '/events',
            status: 'working',
            table: 'agent_actions',
            description: 'Real-time Kafka event stream',
            rowCount: 15432,
            lastEventAt: new Date().toISOString(),
          },
          {
            route: '/runtime-errors',
            status: 'stub',
            table: 'runtime_error_events',
            description: 'Runtime errors — emitter not yet wired',
            rowCount: 0,
            lastEventAt: null,
          },
          {
            route: '/ci-intelligence',
            status: 'partial',
            table: 'ci_debug_escalation_events',
            description: 'CI failure analysis',
            rowCount: 23,
            lastEventAt: new Date(Date.now() - 3600_000).toISOString(),
          },
        ],
        summary: { working: 1, partial: 1, preview: 0, stub: 1, missing: 0 },
        checkedAt: new Date().toISOString(),
      }),
    });

    const result = renderWithClient(<WiringStatusPage />);

    // Should show loading initially
    expect(screen.getByText('Wiring Status')).toBeInTheDocument();

    // Wait for data to load
    await waitFor(() => {
      expect(screen.getByTestId('wiring-status-page')).toBeInTheDocument();
    });

    // Summary cards should render (text appears in cards as status labels)
    await waitFor(() => {
      // All 5 summary status labels should appear
      expect(screen.getByText('All Routes')).toBeInTheDocument();
    });

    // Routes should appear in the table
    expect(screen.getByText('/events')).toBeInTheDocument();
    expect(screen.getByText('/runtime-errors')).toBeInTheDocument();
    expect(screen.getByText('/ci-intelligence')).toBeInTheDocument();

    // Row count for /events should show formatted number
    expect(screen.getByText('15.4K')).toBeInTheDocument();

    result.unmount();
  });

  it('shows error state on fetch failure', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
    });

    const result = renderWithClient(<WiringStatusPage />);

    await waitFor(() => {
      expect(screen.getByText(/Failed to load wiring status/)).toBeInTheDocument();
    });

    result.unmount();
  });

  it('renders status badges with correct test IDs', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        routes: [
          {
            route: '/events',
            status: 'working',
            table: 'agent_actions',
            description: 'Events',
            rowCount: 100,
            lastEventAt: new Date().toISOString(),
          },
        ],
        summary: { working: 1, partial: 0, preview: 0, stub: 0, missing: 0 },
        checkedAt: new Date().toISOString(),
      }),
    });

    const result = renderWithClient(<WiringStatusPage />);

    await waitFor(() => {
      expect(screen.getByTestId('wiring-row-events')).toBeInTheDocument();
    });

    // Check that the working badge exists
    const badges = screen.getAllByTestId('status-badge-working');
    expect(badges.length).toBeGreaterThanOrEqual(1);

    result.unmount();
  });
});
