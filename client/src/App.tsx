import { useState, useEffect } from 'react';
import { Switch, Route, Redirect } from 'wouter';
import { queryClient, apiRequest } from './lib/queryClient';
import { QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { AppSidebar } from '@/components/app-sidebar';
import { ThemeProvider } from '@/components/ThemeProvider';
import { ThemeToggle } from '@/components/ThemeToggle';
import { AlertBanner } from '@/components/AlertBanner';
import { DemoModeProvider } from '@/contexts/DemoModeContext';
import { DemoModeToggle } from '@/components/DemoModeToggle';
import { DemoControlPanel } from '@/components/DemoControlPanel';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useAuth } from '@/hooks/useAuth';
import { useHealthProbe, type HealthProbeStatus } from '@/hooks/useHealthProbe';
import LoginPage from '@/pages/LoginPage';

// Archived legacy pages (OMN-1377)
import IntelligenceOperations from '@/_archive/pages/IntelligenceOperations';
import CodeIntelligence from '@/_archive/pages/CodeIntelligence';
import EventFlow from '@/_archive/pages/EventFlow';
import EventBusExplorer from '@/_archive/pages/EventBusExplorer';
import KnowledgeGraph from '@/_archive/pages/KnowledgeGraph';
import PlatformHealth from '@/_archive/pages/PlatformHealth';
import DeveloperExperience from '@/_archive/pages/DeveloperExperience';

// Active pages
import PatternLearning from '@/pages/PatternLearning';
import EventBusMonitor from '@/pages/EventBusMonitor';
import Chat from '@/pages/Chat';
import CorrelationTrace from '@/pages/CorrelationTrace';
import DashboardDemo from '@/pages/DashboardDemo';
import WidgetShowcase from '@/pages/WidgetShowcase';
import NodeRegistry from '@/pages/NodeRegistry';
import LiveEventStream from '@/pages/LiveEventStream';
import ExecutionGraph from '@/pages/ExecutionGraph';
import RegistryDiscovery from '@/pages/RegistryDiscovery';
import IntentDashboard from '@/pages/IntentDashboard';
import ValidationDashboard from '@/pages/ValidationDashboard';
import ExtractionDashboard from '@/pages/ExtractionDashboard';
import EffectivenessSummary from '@/pages/EffectivenessSummary';
import EffectivenessLatency from '@/pages/EffectivenessLatency';
import EffectivenessUtilization from '@/pages/EffectivenessUtilization';
import EffectivenessAB from '@/pages/EffectivenessAB';
import BaselinesROI from '@/pages/BaselinesROI';
import CostTrendDashboard from '@/pages/CostTrendDashboard';
import PatternEnforcement from '@/pages/PatternEnforcement';
import ContextEnrichmentDashboard from '@/pages/ContextEnrichmentDashboard';
import LlmRoutingDashboard from '@/pages/LlmRoutingDashboard';
import WhyThisHappened from '@/pages/WhyThisHappened';
import StatusDashboard from '@/pages/StatusDashboard';
// Wave 2 omniclaude state event dashboards (OMN-2602)
import GateDecisionDashboard from '@/pages/GateDecisionDashboard';
import EpicPipelineDashboard from '@/pages/EpicPipelineDashboard';
import PRWatchDashboard from '@/pages/PRWatchDashboard';
import PipelineBudgetDashboard from '@/pages/PipelineBudgetDashboard';
import DebugEscalationDashboard from '@/pages/DebugEscalationDashboard';
import ObjectiveEvaluation from '@/pages/ObjectiveEvaluation';
// CDQA gate dashboard (OMN-3190)
import CdqaGateDashboard from '@/pages/CdqaGateDashboard';
// Integration command center dashboards (OMN-3192)
import PipelineHealthDashboard from '@/pages/PipelineHealthDashboard';
import EventBusHealthDashboard from '@/pages/EventBusHealthDashboard';
// Plan reviewer dashboard (OMN-3324)
import PlanReviewer from '@/pages/PlanReviewer';
// Model Efficiency Index dashboard (OMN-3941)
import ModelEfficiencyDashboard from '@/pages/ModelEfficiencyDashboard';
// Delegation Metrics dashboard (OMN-2284) — wired in OMN-5194
import DelegationDashboard from '@/pages/DelegationDashboard';
// Topic Topology Visualization (OMN-5294)
import TopicTopologyDashboard from '@/pages/TopicTopologyDashboard';
// Runtime health dashboard (OMN-3598)
import WorkerHealthPage from '@/components/worker-health/WorkerHealthPage';

// Phase 2: Category landing pages (OMN-2181)
import SpeedCategory from '@/pages/SpeedCategory';
import SuccessCategory from '@/pages/SuccessCategory';
import IntelligenceCategory from '@/pages/IntelligenceCategory';
import SystemHealthCategory from '@/pages/SystemHealthCategory';

// Preview pages
import EnhancedAnalytics from '@/pages/preview/EnhancedAnalytics';
import SystemHealth from '@/pages/preview/SystemHealth';
import AdvancedSettings from '@/pages/preview/AdvancedSettings';
import FeatureShowcase from '@/pages/preview/FeatureShowcase';
import ContractBuilder from '@/pages/preview/ContractBuilder';
import TechDebtAnalysis from '@/pages/preview/TechDebtAnalysis';
import PatternLineage from '@/pages/preview/PatternLineage';
import NodeNetworkComposer from '@/pages/preview/NodeNetworkComposer';
import IntelligenceSavings from '@/pages/preview/IntelligenceSavings';
import AgentRegistry from '@/pages/preview/AgentRegistry';
import AgentNetwork from '@/pages/preview/AgentNetwork';
import IntelligenceAnalytics from '@/pages/preview/IntelligenceAnalytics';
import PlatformMonitoring from '@/pages/preview/PlatformMonitoring';
import AgentManagement from '@/pages/preview/AgentManagement';
import CodeIntelligenceSuite from '@/pages/preview/CodeIntelligenceSuite';
import ArchitectureNetworks from '@/pages/preview/ArchitectureNetworks';
import DeveloperTools from '@/pages/preview/DeveloperTools';

function Router() {
  return (
    <Switch>
      <Route path="/" component={EventBusMonitor} />

      {/* Phase 2: Category landing pages (OMN-2181) */}
      <Route path="/category/speed" component={SpeedCategory} />
      <Route path="/category/success" component={SuccessCategory} />
      <Route path="/category/intelligence" component={IntelligenceCategory} />
      <Route path="/category/health" component={SystemHealthCategory} />

      <Route path="/patterns" component={PatternLearning} />
      <Route path="/intelligence" component={IntelligenceOperations} />
      <Route path="/code" component={CodeIntelligence} />
      <Route path="/events" component={EventBusMonitor} />
      <Route path="/live-events" component={LiveEventStream} />
      {/* Render function pattern required: EventFlow has optional props incompatible with RouteComponentProps */}
      <Route path="/events-legacy">{() => <EventFlow />}</Route>
      <Route path="/event-bus" component={EventBusExplorer} />
      <Route path="/knowledge" component={KnowledgeGraph} />
      <Route path="/health" component={PlatformHealth} />
      <Route path="/developer" component={DeveloperExperience} />
      <Route path="/chat" component={Chat} />
      <Route path="/trace" component={CorrelationTrace} />
      <Route path="/graph" component={ExecutionGraph} />
      <Route path="/demo" component={DashboardDemo} />
      <Route path="/showcase" component={WidgetShowcase} />
      <Route path="/registry" component={NodeRegistry} />
      <Route path="/discovery" component={RegistryDiscovery} />
      <Route path="/intents" component={IntentDashboard} />
      <Route path="/validation" component={ValidationDashboard} />
      <Route path="/extraction" component={ExtractionDashboard} />

      {/* OMN-2924: /insights redirected to /patterns — learnedPatterns table removed */}
      <Route path="/insights">{() => <Redirect to="/patterns" />}</Route>

      {/* Effectiveness dashboard routes (OMN-1891) — sub-routes before parent [OMN-2848] */}
      <Route path="/effectiveness/latency" component={EffectivenessLatency} />
      <Route path="/effectiveness/utilization" component={EffectivenessUtilization} />
      <Route path="/effectiveness/ab" component={EffectivenessAB} />
      <Route path="/effectiveness" component={EffectivenessSummary} />

      {/* Baselines & ROI dashboard (OMN-2156) */}
      <Route path="/baselines" component={BaselinesROI} />

      {/* Cost Trends dashboard (OMN-2242) */}
      <Route path="/cost-trends" component={CostTrendDashboard} />

      {/* Pattern Enforcement dashboard (OMN-2275) */}
      <Route path="/enforcement" component={PatternEnforcement} />

      {/* Context Enrichment dashboard (OMN-2280) */}
      <Route path="/enrichment" component={ContextEnrichmentDashboard} />

      {/* LLM Routing Effectiveness dashboard (OMN-2279) */}
      <Route path="/llm-routing" component={LlmRoutingDashboard} />

      {/* Why This Happened — decision provenance panel (OMN-2350 epic) */}
      <Route path="/why" component={WhyThisHappened} />

      {/* Topic Topology Visualization (OMN-5294) */}
      <Route path="/topic-topology" component={TopicTopologyDashboard} />

      {/* Status dashboard — PR triage, workstreams, hook feed (OMN-2658) */}
      <Route path="/status" component={StatusDashboard} />

      {/* Wave 2 omniclaude state event dashboards (OMN-2602) */}
      <Route path="/gate-decisions" component={GateDecisionDashboard} />
      <Route path="/epic-pipeline" component={EpicPipelineDashboard} />
      <Route path="/pr-watch" component={PRWatchDashboard} />
      <Route path="/pipeline-budget" component={PipelineBudgetDashboard} />
      <Route path="/debug-escalation" component={DebugEscalationDashboard} />
      <Route path="/cdqa-gates" component={CdqaGateDashboard} />
      {/* Integration command center dashboards (OMN-3192) */}
      <Route path="/pipeline-health" component={PipelineHealthDashboard} />
      <Route path="/event-bus-health" component={EventBusHealthDashboard} />

      {/* Objective Evaluation — score vectors, gate failures, policy state, anti-gaming (OMN-2583) */}
      <Route path="/objective" component={ObjectiveEvaluation} />

      {/* Plan Reviewer — strategy comparison + model accuracy leaderboard (OMN-3324) */}
      <Route path="/plan-reviewer" component={PlanReviewer} />

      {/* Runtime Health — container status + restart counts (OMN-3598) */}
      <Route path="/worker-health" component={WorkerHealthPage} />

      {/* Model Efficiency Index dashboard (OMN-3941) */}
      <Route path="/model-efficiency" component={ModelEfficiencyDashboard} />

      {/* Delegation Metrics dashboard (OMN-2284) — wired in OMN-5194 */}
      <Route path="/delegation" component={DelegationDashboard} />

      {/* Preview routes */}
      <Route path="/preview/analytics" component={EnhancedAnalytics} />
      <Route path="/preview/health" component={SystemHealth} />
      <Route path="/preview/settings" component={AdvancedSettings} />
      <Route path="/preview/showcase" component={FeatureShowcase} />
      <Route path="/preview/contracts" component={ContractBuilder} />
      <Route path="/preview/tech-debt" component={TechDebtAnalysis} />
      <Route path="/preview/pattern-lineage" component={PatternLineage} />
      <Route path="/preview/composer" component={NodeNetworkComposer} />
      <Route path="/preview/savings" component={IntelligenceSavings} />
      <Route path="/preview/agent-registry" component={AgentRegistry} />
      <Route path="/preview/agent-network" component={AgentNetwork} />
      <Route path="/preview/intelligence-analytics" component={IntelligenceAnalytics} />
      <Route path="/preview/platform-monitoring" component={PlatformMonitoring} />
      <Route path="/preview/agent-management" component={AgentManagement} />
      <Route path="/preview/code-intelligence-suite" component={CodeIntelligenceSuite} />
      <Route path="/preview/architecture-networks" component={ArchitectureNetworks} />
      <Route path="/preview/developer-tools" component={DeveloperTools} />
    </Switch>
  );
}

/**
 * System health indicator for the global top bar (OMN-4515).
 * Polls /api/health-probe which is public (no auth required) so it works
 * in k8s without a user session.
 */
function SystemHealthIndicator({ status }: { status: HealthProbeStatus }) {
  const dotClass =
    status === 'up'
      ? 'bg-emerald-500'
      : status === 'degraded'
        ? 'bg-amber-500'
        : status === 'down'
          ? 'bg-red-500'
          : 'bg-gray-400';

  const label =
    status === 'up'
      ? 'Healthy'
      : status === 'degraded'
        ? 'Degraded'
        : status === 'down'
          ? 'Down'
          : 'Unknown';

  return (
    <div
      className="flex items-center gap-1.5"
      title={`System health: ${label}`}
      data-testid="system-health-indicator"
    >
      <span className={`h-2 w-2 rounded-full ${dotClass}`} />
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

function Dashboard() {
  const style = {
    '--sidebar-width': '16rem',
    '--sidebar-width-icon': '3rem',
  };

  const { user } = useAuth();

  // WebSocket connection for global status indicator
  const { isConnected, connectionStatus } = useWebSocket({
    debug: false,
  });

  // System health probe — polls public /api/health-probe (no auth required,
  // works in k8s without a user session). OMN-4515.
  const { status: healthStatus } = useHealthProbe();

  // Bus identity badge — reflects server's env at startup (does not hot-reload)
  const [runtimeEnv, setRuntimeEnv] = useState<{
    busId: string;
    kafkaBrokers: string;
    namespace: string;
  } | null>(null);

  useEffect(() => {
    fetch('/api/runtime-environment', { credentials: 'include' })
      .then((r) => r.json())
      .then(setRuntimeEnv)
      .catch(() => null);
  }, []);

  const handleLogout = async () => {
    try {
      const res = await apiRequest('POST', '/auth/logout');
      const { logoutUrl } = await res.json();
      window.location.href = logoutUrl;
    } catch {
      // Fallback: just redirect to login
      window.location.href = '/auth/login';
    }
  };

  return (
    <SidebarProvider style={style as React.CSSProperties}>
      <div className="flex h-screen w-full">
        <AppSidebar />
        <div className="flex flex-col flex-1 overflow-hidden">
          <header className="flex items-center justify-between px-6 py-4 border-b border-border">
            <div className="flex items-center gap-4">
              <SidebarTrigger data-testid="button-sidebar-toggle" />
              <div className="flex items-center gap-3">
                <img
                  src="/logo-inline.svg"
                  alt="OmniNode"
                  className="h-7 w-auto max-w-[180px] dark:brightness-0 dark:invert"
                />
              </div>
            </div>

            <div className="flex items-center gap-4">
              <DemoModeToggle />
              {/* System health indicator (OMN-4515) — polls public /api/health-probe */}
              <SystemHealthIndicator status={healthStatus} />
              <div className="flex items-center gap-2">
                <div
                  className={`h-2 w-2 rounded-full transition-colors duration-300 ${
                    isConnected
                      ? 'bg-green-500 animate-pulse'
                      : connectionStatus === 'connecting'
                        ? 'bg-yellow-500 animate-pulse'
                        : 'bg-gray-400'
                  }`}
                />
                <span className="text-xs text-muted-foreground">
                  {isConnected
                    ? 'Connected'
                    : connectionStatus === 'connecting'
                      ? 'Connecting...'
                      : 'Offline'}
                </span>
              </div>
              {runtimeEnv && (
                <span
                  className="text-xs font-mono px-2 py-1 rounded bg-muted text-muted-foreground border"
                  title={`Broker: ${runtimeEnv.kafkaBrokers} | NS: ${runtimeEnv.namespace}`}
                >
                  {runtimeEnv.busId === 'cloud' ? '☁' : '⚡'} {runtimeEnv.busId}
                </span>
              )}
              <DemoControlPanel />
              {user && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {user.email || user.preferred_username || user.sub}
                  </span>
                  <button
                    onClick={handleLogout}
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Sign out
                  </button>
                </div>
              )}
              <ThemeToggle />
            </div>
          </header>

          <AlertBanner />

          <main className="flex-1 overflow-auto p-8">
            <Router />
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}

function AuthGate() {
  const { authenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!authenticated) {
    return <LoginPage />;
  }

  return <Dashboard />;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <DemoModeProvider>
        <ThemeProvider defaultTheme="dark">
          <TooltipProvider>
            <AuthGate />
            <Toaster />
          </TooltipProvider>
        </ThemeProvider>
      </DemoModeProvider>
    </QueryClientProvider>
  );
}

export default App;
