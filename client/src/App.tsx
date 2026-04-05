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
import { PreferencesProvider } from '@/contexts/PreferencesContext';
import { DemoModeToggle } from '@/components/DemoModeToggle';
import { DemoControlPanel } from '@/components/DemoControlPanel';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useAuth } from '@/hooks/useAuth';
import { useHealthProbe, type HealthProbeStatus } from '@/hooks/useHealthProbe';
import { usePostHogPageview } from '@/hooks/use-posthog-pageview';
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
import ContextEffectivenessDashboard from '@/pages/ContextEffectivenessDashboard';
import MemoryDashboard from '@/pages/MemoryDashboard';
import LlmRoutingDashboard from '@/pages/LlmRoutingDashboard';
import WhyThisHappened from '@/pages/WhyThisHappened';
import StatusDashboard from '@/pages/StatusDashboard';
// Skill Dashboard (OMN-5278)
import SkillDashboard from '@/pages/SkillDashboard';
// Wave 2 omniclaude state event dashboards (OMN-2602)
import GateDecisionDashboard from '@/pages/GateDecisionDashboard';
import EpicPipelineDashboard from '@/pages/EpicPipelineDashboard';
import PRWatchDashboard from '@/pages/PRWatchDashboard';
import PipelineBudgetDashboard from '@/pages/PipelineBudgetDashboard';
import DebugEscalationDashboard from '@/pages/DebugEscalationDashboard';
import CIIntelligenceDashboard from '@/pages/CIIntelligenceDashboard';
import ObjectiveEvaluation from '@/pages/ObjectiveEvaluation';
// A/B Eval Results dashboard (OMN-6780)
import EvalResults from '@/pages/EvalResults';
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
// Decision Store dashboard (OMN-5280)
import DecisionStoreDashboard from '@/pages/DecisionStoreDashboard';
// DoD Verification dashboard (OMN-5200)
import DodDashboard from '@/pages/DodDashboard';
// Intent Drift dashboard (OMN-5281)
import IntentDriftDashboard from '@/pages/IntentDriftDashboard';
// Runtime health dashboard (OMN-3598)
import WorkerHealthPage from '@/components/worker-health/WorkerHealthPage';
// LLM Health Dashboard (OMN-5279)
import LlmHealthDashboard from '@/pages/LlmHealthDashboard';
// Wiring Health Dashboard (OMN-5292)
import WiringHealthDashboard from '@/pages/WiringHealthDashboard';
// DLQ Monitor Dashboard (OMN-5287)
import DlqMonitorDashboard from '@/pages/DlqMonitorDashboard';
// Circuit Breaker dashboard (OMN-5293)
import CircuitBreakerDashboard from '@/pages/CircuitBreakerDashboard';
// Feature Flags dashboard (OMN-5582)
import FeatureFlagsDashboard from '@/pages/FeatureFlagsDashboard';
// Consumer Health dashboard (OMN-5527)
import ConsumerHealthDashboard from '@/pages/ConsumerHealthDashboard';
// Runtime Errors dashboard (OMN-5528)
import RuntimeErrorsDashboard from '@/pages/RuntimeErrorsDashboard';
// RL Routing Comparison dashboard (OMN-5570)
import RLRouting from '@/pages/RLRouting';
// Review Calibration dashboard (OMN-6177)
import ReviewCalibrationDashboard from '@/pages/ReviewCalibrationDashboard';
// Compliance dashboard (OMN-5285)
import ComplianceDashboard from '@/pages/ComplianceDashboard';
// Routing Feedback dashboard (OMN-5284)
import RoutingFeedbackDashboard from '@/pages/RoutingFeedbackDashboard';
// Pattern Lifecycle dashboard (OMN-5283)
import PatternLifecycleDashboard from '@/pages/PatternLifecycleDashboard';
// Hostile Reviewer dashboard (OMN-6610)
import HostileReviewerDashboard from '@/pages/HostileReviewerDashboard';
// Empty route scaffolds (OMN-6753)
import AgentsDashboard from '@/pages/AgentsDashboard';
import DriftDashboard from '@/pages/DriftDashboard';
import PipelineDashboard from '@/pages/PipelineDashboard';
import SettingsDashboard from '@/pages/SettingsDashboard';
// Wiring Status dashboard (OMN-6975)
import WiringStatusPage from '@/pages/WiringStatus';
// Subsystem Health dashboard (OMN-7007)
import SubsystemHealthPage from '@/pages/SubsystemHealthPage';
// Agent Coordination dashboard (OMN-7036)
import AgentCoordinationDashboard from '@/pages/AgentCoordinationDashboard';
// Event Ledger dashboard (feature-hookup Phase 1)
import EventLedgerDashboard from '@/pages/EventLedgerDashboard';
// Doc Freshness dashboard (feature-hookup Phase 2)
import DocFreshnessDashboard from '@/pages/DocFreshnessDashboard';
// Security Posture dashboard (feature-hookup Phase 4)
import SecurityPostureDashboard from '@/pages/SecurityPostureDashboard';
// Alert History dashboard
import AlertHistoryDashboard from '@/pages/AlertHistoryDashboard';
// Integration Catalog dashboard (feature-hookup Phase 3)
import IntegrationCatalogDashboard from '@/pages/IntegrationCatalogDashboard';
// System Activity dashboard
import SystemActivityDashboard from '@/pages/SystemActivityDashboard';

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

      {/* Context Effectiveness dashboard (OMN-5286) */}
      <Route path="/context-effectiveness" component={ContextEffectivenessDashboard} />

      {/* OmniMemory dashboard (OMN-5508) */}
      <Route path="/memory" component={MemoryDashboard} />

      {/* LLM Routing Effectiveness dashboard (OMN-2279) */}
      <Route path="/llm-routing" component={LlmRoutingDashboard} />

      {/* Why This Happened — decision provenance panel (OMN-2350 epic) */}
      <Route path="/why" component={WhyThisHappened} />

      {/* Topic Topology Visualization (OMN-5294) */}
      <Route path="/topic-topology" component={TopicTopologyDashboard} />

      {/* Status dashboard — PR triage, workstreams, hook feed (OMN-2658) */}
      <Route path="/status" component={StatusDashboard} />

      {/* Skill Dashboard (OMN-5278) */}
      <Route path="/skills" component={SkillDashboard} />

      {/* Wave 2 omniclaude state event dashboards (OMN-2602) */}
      <Route path="/gate-decisions" component={GateDecisionDashboard} />
      <Route path="/epic-pipeline" component={EpicPipelineDashboard} />
      <Route path="/pr-watch" component={PRWatchDashboard} />
      <Route path="/pipeline-budget" component={PipelineBudgetDashboard} />
      <Route path="/debug-escalation" component={DebugEscalationDashboard} />
      {/* CI Intelligence Dashboard — failure pattern analysis + escalation timeline (OMN-5282) */}
      <Route path="/ci-intelligence" component={CIIntelligenceDashboard} />
      <Route path="/cdqa-gates" component={CdqaGateDashboard} />
      {/* Integration command center dashboards (OMN-3192) */}
      <Route path="/pipeline-health" component={PipelineHealthDashboard} />
      <Route path="/event-bus-health" component={EventBusHealthDashboard} />
      {/* Wiring Health dashboard (OMN-5292) */}
      <Route path="/wiring-health" component={WiringHealthDashboard} />

      {/* Objective Evaluation — score vectors, gate failures, policy state, anti-gaming (OMN-2583) */}
      <Route path="/objective" component={ObjectiveEvaluation} />

      {/* A/B Eval Results — ONEX ON vs OFF comparison (OMN-6780) */}
      <Route path="/eval-results" component={EvalResults} />

      {/* Plan Reviewer — strategy comparison + model accuracy leaderboard (OMN-3324) */}
      <Route path="/plan-reviewer" component={PlanReviewer} />

      {/* Runtime Health — container status + restart counts (OMN-3598) */}
      <Route path="/worker-health" component={WorkerHealthPage} />

      {/* LLM Health Dashboard — per-endpoint latency, error rate, throughput (OMN-5279) */}
      <Route path="/llm-health" component={LlmHealthDashboard} />

      {/* DLQ Monitor — dead-letter queue failures (OMN-5287) */}
      <Route path="/dlq" component={DlqMonitorDashboard} />

      {/* Circuit Breaker — infra circuit breaker state transitions (OMN-5293) */}
      <Route path="/circuit-breaker" component={CircuitBreakerDashboard} />

      {/* Feature Flags — contract-declared feature flag management (OMN-5582) */}
      <Route path="/feature-flags" component={FeatureFlagsDashboard} />

      {/* Consumer Health — consumer heartbeat/session/rebalance events (OMN-5527) */}
      <Route path="/consumer-health" component={ConsumerHealthDashboard} />

      {/* Runtime Errors — structured runtime error events (OMN-5528) */}
      <Route path="/runtime-errors" component={RuntimeErrorsDashboard} />

      {/* RL Routing Comparison — shadow mode vs static routing (OMN-5570) */}
      <Route path="/rl-routing" component={RLRouting} />

      {/* Review Calibration — convergence metrics, noise trends, model scores (OMN-6177) */}
      <Route path="/review-calibration" component={ReviewCalibrationDashboard} />

      {/* Hostile Reviewer — run history, convergence metrics, verdict breakdown (OMN-6610) */}
      <Route path="/hostile-reviewer" component={HostileReviewerDashboard} />

      {/* Compliance dashboard (OMN-5285) */}
      <Route path="/compliance" component={ComplianceDashboard} />

      {/* Security Posture dashboard (feature-hookup Phase 4) */}
      <Route path="/security-posture" component={SecurityPostureDashboard} />

      {/* Routing Feedback dashboard (OMN-5284) */}
      <Route path="/routing-feedback" component={RoutingFeedbackDashboard} />

      {/* Pattern Lifecycle dashboard (OMN-5283) */}
      <Route path="/pattern-lifecycle" component={PatternLifecycleDashboard} />

      {/* Model Efficiency Index dashboard (OMN-3941) */}
      <Route path="/model-efficiency" component={ModelEfficiencyDashboard} />

      {/* Delegation Metrics dashboard (OMN-2284) — wired in OMN-5194 */}
      <Route path="/delegation" component={DelegationDashboard} />

      {/* Decision Store dashboard (OMN-5280) */}
      <Route path="/decisions" component={DecisionStoreDashboard} />

      {/* DoD Verification dashboard (OMN-5200) */}
      <Route path="/dod" component={DodDashboard} />

      {/* Intent Drift dashboard (OMN-5281) */}
      <Route path="/intent-drift" component={IntentDriftDashboard} />

      {/* Empty route scaffolds (OMN-6753) */}
      <Route path="/agents" component={AgentsDashboard} />
      <Route path="/drift" component={DriftDashboard} />
      <Route path="/pipeline" component={PipelineDashboard} />
      <Route path="/settings" component={SettingsDashboard} />

      {/* Wiring Status dashboard (OMN-6975) */}
      <Route path="/wiring-status" component={WiringStatusPage} />
      {/* Subsystem Health dashboard (OMN-7007) */}
      <Route path="/subsystem-health" component={SubsystemHealthPage} />
      {/* Agent Coordination dashboard (OMN-7036) */}
      <Route path="/agent-coordination" component={AgentCoordinationDashboard} />
      {/* Event Ledger dashboard (feature-hookup Phase 1) */}
      <Route path="/event-ledger" component={EventLedgerDashboard} />
      {/* Doc Freshness dashboard (feature-hookup Phase 2) */}
      <Route path="/doc-freshness" component={DocFreshnessDashboard} />
      {/* Integration Catalog dashboard (feature-hookup Phase 3) */}
      <Route path="/integrations" component={IntegrationCatalogDashboard} />

      {/* Alert History dashboard */}
      <Route path="/alert-history" component={AlertHistoryDashboard} />

      {/* System Activity dashboard */}
      <Route path="/system-activity" component={SystemActivityDashboard} />

      {/* Preview routes */}
      <Route path="/preview/analytics" component={EnhancedAnalytics} />
      <Route path="/preview/health" component={SystemHealth} />
      <Route path="/preview/settings" component={AdvancedSettings} />
      <Route path="/preview/showcase" component={FeatureShowcase} />
      <Route path="/preview/contracts" component={ContractBuilder} />
      <Route path="/preview/tech-debt" component={TechDebtAnalysis} />
      <Route path="/preview/pattern-lineage" component={PatternLineage} />
      <Route path="/preview/composer" component={NodeNetworkComposer} />
      {/* Token Savings — promoted from /preview/savings to /savings (OMN-6968) */}
      <Route path="/savings" component={IntelligenceSavings} />
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
  usePostHogPageview();

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
        <PreferencesProvider>
          <ThemeProvider defaultTheme="dark">
            <TooltipProvider>
              <AuthGate />
              <Toaster />
            </TooltipProvider>
          </ThemeProvider>
        </PreferencesProvider>
      </DemoModeProvider>
    </QueryClientProvider>
  );
}

export default App;
