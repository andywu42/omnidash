import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';

vi.mock('@/components/app-sidebar', () => ({
  AppSidebar: () => <aside data-testid="app-sidebar" />,
}));

vi.mock('@/components/AlertBanner', () => ({
  AlertBanner: () => null,
}));

vi.mock('@/components/ThemeToggle', () => ({
  ThemeToggle: () => <button data-testid="theme-toggle">theme</button>,
}));

vi.mock('@/components/DemoModeToggle', () => ({
  DemoModeToggle: () => <button data-testid="demo-mode-toggle">demo</button>,
}));

vi.mock('@/components/ThemeProvider', () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/ui/toaster', () => ({
  Toaster: () => null,
}));

vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

vi.mock('@/components/ui/sidebar', () => ({
  SidebarProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SidebarTrigger: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button data-testid="button-sidebar-toggle" {...props}>
      toggle
    </button>
  ),
}));

vi.mock('@/contexts/DemoModeContext', () => ({
  DemoModeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useDemoMode: vi.fn(() => ({
    isDemoMode: false,
    toggleDemoMode: vi.fn(),
  })),
}));

vi.mock('@/pages/NodeRegistry', () => ({
  default: () => <div data-testid="page-node-registry">page-node-registry</div>,
}));
vi.mock('@/pages/EventBusMonitor', () => ({
  default: () => <div data-testid="page-event-bus-monitor">page-event-bus-monitor</div>,
}));
vi.mock('@/pages/DashboardDemo', () => ({
  default: () => <div data-testid="page-dashboard-demo">page-dashboard-demo</div>,
}));
vi.mock('@/pages/WidgetShowcase', () => ({
  default: () => <div data-testid="page-widget-showcase">page-widget-showcase</div>,
}));
vi.mock('@/_archive/pages/PatternLearning', () => ({
  default: () => <div data-testid="page-pattern-learning">page-pattern-learning</div>,
}));
vi.mock('@/_archive/pages/IntelligenceOperations', () => ({
  default: () => <div data-testid="page-intelligence-operations">page-intelligence-operations</div>,
}));
vi.mock('@/_archive/pages/CodeIntelligence', () => ({
  default: () => <div data-testid="page-code-intelligence">page-code-intelligence</div>,
}));
vi.mock('@/_archive/pages/EventFlow', () => ({
  default: () => <div data-testid="page-event-flow">page-event-flow</div>,
}));
vi.mock('@/_archive/pages/EventBusExplorer', () => ({
  default: () => <div data-testid="page-event-bus-explorer">page-event-bus-explorer</div>,
}));
vi.mock('@/_archive/pages/KnowledgeGraph', () => ({
  default: () => <div data-testid="page-knowledge-graph">page-knowledge-graph</div>,
}));
vi.mock('@/_archive/pages/PlatformHealth', () => ({
  default: () => <div data-testid="page-platform-health">page-platform-health</div>,
}));
vi.mock('@/_archive/pages/DeveloperExperience', () => ({
  default: () => <div data-testid="page-developer-experience">page-developer-experience</div>,
}));
vi.mock('@/pages/Chat', () => ({ default: () => <div data-testid="page-chat">page-chat</div> }));
vi.mock('@/pages/CorrelationTrace', () => ({
  default: () => <div data-testid="page-correlation-trace">page-correlation-trace</div>,
}));
vi.mock('@/pages/AgentManagement', () => ({
  default: () => <div data-testid="page-agent-management">page-agent-management</div>,
}));

vi.mock('@/pages/preview/EnhancedAnalytics', () => ({
  default: () => <div data-testid="page-preview-analytics">page-preview-analytics</div>,
}));
vi.mock('@/pages/preview/SystemHealth', () => ({
  default: () => <div data-testid="page-preview-health">page-preview-health</div>,
}));
vi.mock('@/pages/preview/AdvancedSettings', () => ({
  default: () => <div data-testid="page-preview-settings">page-preview-settings</div>,
}));
vi.mock('@/pages/preview/FeatureShowcase', () => ({
  default: () => <div data-testid="page-preview-showcase">page-preview-showcase</div>,
}));
vi.mock('@/pages/preview/ContractBuilder', () => ({
  default: () => <div data-testid="page-preview-contracts">page-preview-contracts</div>,
}));
vi.mock('@/pages/preview/TechDebtAnalysis', () => ({
  default: () => <div data-testid="page-preview-tech-debt">page-preview-tech-debt</div>,
}));
vi.mock('@/pages/preview/PatternLineage', () => ({
  default: () => <div data-testid="page-preview-pattern-lineage">page-preview-pattern-lineage</div>,
}));
vi.mock('@/pages/preview/NodeNetworkComposer', () => ({
  default: () => <div data-testid="page-preview-composer">page-preview-composer</div>,
}));
vi.mock('@/pages/preview/IntelligenceSavings', () => ({
  default: () => <div data-testid="page-preview-savings">page-preview-savings</div>,
}));
vi.mock('@/pages/preview/AgentRegistry', () => ({
  default: () => <div data-testid="page-preview-agent-registry">page-preview-agent-registry</div>,
}));
vi.mock('@/pages/preview/AgentNetwork', () => ({
  default: () => <div data-testid="page-preview-agent-network">page-preview-agent-network</div>,
}));
vi.mock('@/pages/preview/IntelligenceAnalytics', () => ({
  default: () => (
    <div data-testid="page-preview-intelligence-analytics">page-preview-intelligence-analytics</div>
  ),
}));
vi.mock('@/pages/preview/PlatformMonitoring', () => ({
  default: () => (
    <div data-testid="page-preview-platform-monitoring">page-preview-platform-monitoring</div>
  ),
}));
vi.mock('@/pages/preview/AgentManagement', () => ({
  default: () => (
    <div data-testid="page-preview-agent-management">page-preview-agent-management</div>
  ),
}));
vi.mock('@/pages/preview/CodeIntelligenceSuite', () => ({
  default: () => <div data-testid="page-preview-code-suite">page-preview-code-suite</div>,
}));
vi.mock('@/pages/preview/ArchitectureNetworks', () => ({
  default: () => (
    <div data-testid="page-preview-architecture-networks">page-preview-architecture-networks</div>
  ),
}));
vi.mock('@/pages/preview/DeveloperTools', () => ({
  default: () => <div data-testid="page-preview-developer-tools">page-preview-developer-tools</div>,
}));

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: vi.fn(),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: vi.fn(),
}));

import { useWebSocket } from '@/hooks/useWebSocket';
import { useAuth } from '@/hooks/useAuth';
import App from '../App';

const useWebSocketMock = vi.mocked(useWebSocket);
const useAuthMock = vi.mocked(useAuth);

describe('App', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/');
    useAuthMock.mockReturnValue({
      authenticated: true,
      isLoading: false,
      user: { sub: 'test-user', email: 'test@example.com' },
    });
    useWebSocketMock.mockReturnValue({
      isConnected: true,
      connectionStatus: 'connected',
      error: null,
      send: vi.fn(),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      reconnect: vi.fn(),
      close: vi.fn(),
    });
  });
  it('renders layout with sidebar and connection indicator', () => {
    render(<App />);

    expect(screen.getByTestId('app-sidebar')).toBeInTheDocument();
    expect(screen.getByAltText('OmniNode')).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
  });

  it('navigates to primary route when location changes', async () => {
    render(<App />);

    await act(async () => {
      window.history.pushState({}, '', '/patterns');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(await screen.findByTestId('page-pattern-learning')).toBeInTheDocument();
  });

  it('navigates to preview route when location changes', async () => {
    render(<App />);

    await act(async () => {
      window.history.pushState({}, '', '/preview/analytics');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(await screen.findByTestId('page-preview-analytics')).toBeInTheDocument();
  });

  it('shows connection status when websocket is connecting', () => {
    useWebSocketMock.mockReturnValueOnce({
      isConnected: false,
      connectionStatus: 'connecting',
      error: null,
      send: vi.fn(),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      reconnect: vi.fn(),
      close: vi.fn(),
    });

    render(<App />);

    expect(screen.getByText('Connecting...')).toBeInTheDocument();
  });
});
