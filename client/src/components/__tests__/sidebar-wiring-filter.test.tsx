import { render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';

// Mock wouter to avoid router issues in tests
vi.mock('wouter', () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href} data-testid={`link-${href.slice(1).replace(/\//g, '-')}`}>
      {children}
    </a>
  ),
  useLocation: () => ['/events', vi.fn()],
}));

// Mock useWebSocket
vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: vi.fn().mockReturnValue({ isConnected: false, connectionStatus: 'disconnected' }),
}));

// Mock useAuth
vi.mock('@/hooks/useAuth', () => ({
  useAuth: vi.fn().mockReturnValue({ authenticated: true, isLoading: false, user: null }),
}));

// Mock useHealthProbe
vi.mock('@/hooks/useHealthProbe', () => ({
  useHealthProbe: vi.fn().mockReturnValue({ status: 'up' }),
}));

// Must import after mocks
import { AppSidebar } from '@/components/app-sidebar';
import { DemoModeProvider } from '@/contexts/DemoModeContext';
import { SidebarProvider } from '@/components/ui/sidebar';
import {
  isRouteVisible,
  getRouteWiringStatus,
  getRoutesByStatus,
  wiringStatus,
} from '@shared/wiring-status';
import wiringStatusData from '@shared/wiring-status.json';

function renderSidebar() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <DemoModeProvider>
        <SidebarProvider defaultOpen={true}>
          <AppSidebar />
        </SidebarProvider>
      </DemoModeProvider>
    </QueryClientProvider>
  );
}

describe('Sidebar wiring filter — rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders sidebar without errors', () => {
    const { container } = renderSidebar();
    expect(container.querySelector('[data-testid="advanced-section"]')).toBeInTheDocument();
  });

  it('does not render stub-status pages in sidebar DOM', async () => {
    renderSidebar();

    // Expand the Advanced section
    const user = userEvent.setup();
    const trigger = screen.getByTestId('advanced-section-trigger');
    await user.click(trigger);

    // Stub pages should not be in the DOM at all
    // Runtime Errors is 'stub' status
    expect(screen.queryByTestId('nav-runtime-errors')).not.toBeInTheDocument();
    // Consumer Health is 'stub' status
    expect(screen.queryByTestId('nav-consumer-health')).not.toBeInTheDocument();
    // Feature Flags is 'stub' status
    expect(screen.queryByTestId('nav-feature-flags')).not.toBeInTheDocument();
    // Agents is 'stub' status
    expect(screen.queryByTestId('nav-agents')).not.toBeInTheDocument();
  });

  it('does not render preview-status pages in sidebar DOM', async () => {
    renderSidebar();

    const user = userEvent.setup();
    const trigger = screen.getByTestId('advanced-section-trigger');
    await user.click(trigger);

    // Objective Evaluation is 'preview'
    expect(screen.queryByTestId('nav-objective')).not.toBeInTheDocument();
    // Plan Reviewer is 'preview'
    expect(screen.queryByTestId('nav-plan-reviewer')).not.toBeInTheDocument();
    // RL Routing is 'preview'
    expect(screen.queryByTestId('nav-rl-routing')).not.toBeInTheDocument();
  });
});

describe('Wiring status utilities', () => {
  it('returns correct status for known routes', () => {
    expect(getRouteWiringStatus('/events')).toBe('working');
    expect(getRouteWiringStatus('/runtime-errors')).toBe('stub');
    expect(getRouteWiringStatus('/ci-intelligence')).toBe('partial');
    expect(getRouteWiringStatus('/objective')).toBe('preview');
  });

  it('returns missing for unknown routes', () => {
    expect(getRouteWiringStatus('/nonexistent')).toBe('missing');
  });

  it('isRouteVisible returns true only for working and partial', () => {
    expect(isRouteVisible('/events')).toBe(true);
    expect(isRouteVisible('/ci-intelligence')).toBe(true);
    expect(isRouteVisible('/objective')).toBe(false);
    expect(isRouteVisible('/runtime-errors')).toBe(false);
    expect(isRouteVisible('/nonexistent')).toBe(false);
  });

  it('getRoutesByStatus returns correct routes', () => {
    const working = getRoutesByStatus('working');
    expect(working).toContain('/events');
    expect(working).toContain('/patterns');
    expect(working).not.toContain('/runtime-errors');

    const stub = getRoutesByStatus('stub');
    expect(stub).toContain('/runtime-errors');
    expect(stub).not.toContain('/events');
  });

  it('wiring-status.json has valid structure', () => {
    const validStatuses = ['working', 'partial', 'preview', 'stub', 'missing'];
    const routes = wiringStatusData.routes as Record<string, { status: string }>;
    for (const [route, entry] of Object.entries(routes)) {
      expect(validStatuses).toContain(entry.status);
      expect(route).toMatch(/^\//);
    }
  });

  it('manifest covers expected minimum of routes', () => {
    const routeCount = Object.keys(wiringStatus.routes).length;
    // Should have entries for at least 40 routes (we have ~55 sidebar pages)
    expect(routeCount).toBeGreaterThanOrEqual(40);
  });

  it('working routes outnumber stub routes', () => {
    const working = getRoutesByStatus('working');
    const stub = getRoutesByStatus('stub');
    // Sanity check: we should have more working pages than stubs
    expect(working.length).toBeGreaterThan(stub.length);
  });
});
