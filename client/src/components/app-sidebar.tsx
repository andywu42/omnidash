import {
  Radio,
  ChevronRight,
  ChevronDown,
  Search,
  Layers,
  Globe,
  Brain,
  Sparkles,
  ShieldCheck,
  Database,
  Gauge,
  Activity,
  Lightbulb,
  Zap,
  FlaskConical,
  Wrench,
  DollarSign,
  TrendingUp,
  ShieldAlert,
  Cpu,
  GitFork,
  GitCommit,
  GitBranch,
  Target,
  ClipboardCheck,
  GitPullRequest,
  Server,
  FileSearch,
  Container,
  BarChart3,
  Users,
  Network,
  ListChecks,
  AlertTriangle,
  ToggleLeft,
  HeartPulse,
  Bug,
  Bot,
  GitCompare,
  Workflow,
  Settings,
} from 'lucide-react';
import { Link, useLocation } from 'wouter';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from '@/components/ui/sidebar';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import type { LucideIcon } from 'lucide-react';
import { useDemoMode } from '@/contexts/DemoModeContext';
import { isRouteVisible, getRouteWiringStatus } from '@shared/wiring-status';

/** A single sidebar navigation entry with its route, icon, and description. */
interface NavItem {
  title: string;
  url: string;
  icon: LucideIcon;
  description: string;
}

// OMN-2182: Phase 3 -- Retire legacy views, tuck granular pages under Advanced
// OMN-2181: Phase 2 category dashboards remain as primary navigation
//
// Default nav shows only 4 category pages.
// Advanced/Developer section accessible for granular drill-down views.
// No functionality removed -- just reorganized.
//
// Hidden routes (registered in App.tsx but not in sidebar navigation):
//   /graph             -- Execution Graph (node execution visualization)
//   /live-events       -- Demo Stream (superseded by Event Stream)
//   /discovery         -- Registry Discovery (standalone discovery page)
//   /intelligence      -- Intelligence Operations (archived legacy, OMN-1377)
//   /code              -- Code Intelligence (archived legacy, OMN-1377)
//   /events-legacy     -- Event Flow (archived legacy, OMN-1377)
//   /event-bus         -- Event Bus Explorer (archived legacy, OMN-1377)
//   /knowledge         -- Knowledge Graph (archived legacy, OMN-1377)
//   /health            -- Platform Health (archived legacy, OMN-1377)
//   /developer         -- Developer Experience (archived legacy, OMN-1377)
//   /chat              -- Chat interface
//   /demo              -- Dashboard Demo
//   /effectiveness/*   -- Effectiveness sub-pages (latency, utilization, ab)
//   /preview/*         -- 17 preview/prototype pages

// ─────────────────────────────────────────────────────────────────────────────
// Category Dashboards (OMN-2181) -- primary navigation
// ─────────────────────────────────────────────────────────────────────────────

const categories: NavItem[] = [
  {
    title: 'Speed & Responsiveness',
    url: '/category/speed',
    icon: Zap,
    description: 'Cache hit rate, latency percentiles, pipeline health',
  },
  {
    title: 'Success & Testing',
    url: '/category/success',
    icon: FlaskConical,
    description: 'A/B comparison, injection hit rates, effectiveness trends',
  },
  {
    title: 'Intelligence',
    url: '/category/intelligence',
    icon: Brain,
    description: 'Pattern utilization, intent classification, behavior tracking',
  },
  {
    title: 'System Health',
    url: '/category/health',
    icon: ShieldCheck,
    description: 'Validation counts, node registry, health checks',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Advanced / Developer section (granular drill-down pages)
// ─────────────────────────────────────────────────────────────────────────────

/** A labelled group of nav items within the Advanced section. */
interface AdvancedSubGroup {
  label: string;
  items: NavItem[];
}

const advancedSubGroups: AdvancedSubGroup[] = [
  {
    label: 'Monitoring',
    items: [
      {
        title: 'Event Stream',
        url: '/events',
        icon: Radio,
        description: 'Real-time Kafka event stream visualization',
      },
      {
        title: 'Pipeline Metrics',
        url: '/extraction',
        icon: Gauge,
        description: 'Pattern extraction metrics and pipeline health',
      },
      {
        title: 'Injection Performance',
        url: '/effectiveness',
        icon: Activity,
        description: 'Injection effectiveness metrics and A/B analysis',
      },
      {
        title: 'Baselines & ROI',
        url: '/baselines',
        icon: DollarSign,
        description: 'Cost + outcome comparison for A/B pattern evaluation',
      },
      {
        title: 'Cost Trends',
        url: '/cost-trends',
        icon: TrendingUp,
        description: 'LLM cost and token usage trends with drill-down',
      },
      {
        title: 'CI Intelligence',
        url: '/ci-intelligence',
        icon: GitCommit,
        description: 'CI failure pattern analysis and escalation trigger timeline (OMN-5282)',
      },
      {
        title: 'Hostile Reviewer',
        url: '/hostile-reviewer',
        icon: ShieldAlert,
        description: 'Hostile reviewer run history and convergence metrics (OMN-6610)',
      },
      {
        title: 'Epic Pipeline',
        url: '/epic-pipeline',
        icon: GitBranch,
        description: 'Epic-team pipeline run status and ticket progress',
      },
      {
        title: 'PR Watch',
        url: '/pr-watch',
        icon: GitPullRequest,
        description: 'Open PR tracking with merge-readiness and staleness alerts',
      },
      {
        title: 'Pipeline Budget',
        url: '/pipeline-budget',
        icon: DollarSign,
        description: 'Token and cost budget caps per pipeline run',
      },
    ],
  },
  {
    label: 'Intelligence',
    items: [
      {
        title: 'Intent Signals',
        url: '/intents',
        icon: Brain,
        description: 'Real-time intent classification and analysis',
      },
      {
        title: 'Intent Drift',
        url: '/intent-drift',
        icon: TrendingUp,
        description: 'Agent intent drift detection and severity tracking (OMN-5281)',
      },
      {
        title: 'Pattern Intelligence',
        url: '/patterns',
        icon: Sparkles,
        description: 'Code pattern discovery and learning analytics',
      },
      {
        title: 'Pattern Enforcement',
        url: '/enforcement',
        icon: ShieldAlert,
        description: 'Enforcement hit rate, violations, and correction rate',
      },
      {
        title: 'Context Enrichment',
        url: '/enrichment',
        icon: Cpu,
        description: 'Hit rate per channel, token savings, latency distribution',
      },
      {
        title: 'Context Effectiveness',
        url: '/context-effectiveness',
        icon: Activity,
        description: 'Utilization score by method, injection rate, low-utilization alerts',
      },
      {
        title: 'LLM Routing',
        url: '/llm-routing',
        icon: GitFork,
        description: 'LLM vs fuzzy routing agreement rate, latency, cost per decision',
      },
      {
        title: 'RL Routing',
        url: '/rl-routing',
        icon: GitFork,
        description: 'Shadow mode learned policy vs static rules comparison (OMN-5570)',
      },
      // NOTE: 'Why This Happened' (/why) is hidden until OMN-2467 (DecisionRecord API) ships.
      // The page exists but always shows mock data, so it is excluded from nav outside demo mode.
      {
        title: 'Objective Evaluation',
        url: '/objective',
        icon: Target,
        description: 'Score vectors, gate failures, policy state history, anti-gaming alerts',
      },
      {
        title: 'CDQA Gates',
        url: '/cdqa-gates',
        icon: ClipboardCheck,
        description: 'CDQA gate evaluation results per PR (OMN-3190)',
      },
      {
        title: 'Plan Reviewer',
        url: '/plan-reviewer',
        icon: FileSearch,
        description: 'Plan-review strategy comparison and model accuracy leaderboard (OMN-3324)',
      },
      {
        title: 'Model Efficiency',
        url: '/model-efficiency',
        icon: BarChart3,
        description:
          'Model Efficiency Index (MEI) — VTS per kLoC comparison across models (OMN-3941)',
      },
      {
        title: 'Delegation',
        url: '/delegation',
        icon: Users,
        description:
          'Task delegation rate, quality gate pass rate, shadow validation divergence (OMN-2284)',
      },
      {
        title: 'Decision Store',
        url: '/decisions',
        icon: FileSearch,
        description: 'Decision provenance and intent-vs-plan comparison',
      },
      {
        title: 'OmniMemory',
        url: '/memory',
        icon: Database,
        description:
          'Document ingestion stats, memory store status, and retrieval metrics (OMN-5290)',
      },
      {
        title: 'Review Calibration',
        url: '/review-calibration',
        icon: Target,
        description:
          'Calibration loop convergence, noise trends, model scores, few-shot injection log (OMN-6177)',
      },
      {
        title: 'Skills',
        url: '/skills',
        icon: Wrench,
        description: 'Registered skill inventory and execution metrics (OMN-5278)',
      },
      {
        title: 'Routing Feedback',
        url: '/routing-feedback',
        icon: GitFork,
        description: 'Routing decision feedback loop and correction rate (OMN-5284)',
      },
      {
        title: 'Pattern Lifecycle',
        url: '/pattern-lifecycle',
        icon: Sparkles,
        description: 'Pattern creation, promotion, deprecation, and retirement (OMN-5283)',
      },
      {
        title: 'Token Savings',
        url: '/savings',
        icon: DollarSign,
        description: 'Token and cost savings from pattern injection (OMN-6968)',
      },
    ],
  },
  {
    label: 'System',
    items: [
      {
        title: 'Node Registry',
        url: '/registry',
        icon: Globe,
        description: 'Contract-driven node and service discovery',
      },
      {
        title: 'Validation',
        url: '/validation',
        icon: ShieldCheck,
        description: 'Cross-repo validation runs and violation trends',
      },
      {
        title: 'Pipeline Health',
        url: '/pipeline-health',
        icon: GitPullRequest,
        description: 'Per-ticket pipeline state, stuck detection, CDQA gate results (OMN-3192)',
      },
      {
        title: 'DoD Verification',
        url: '/dod',
        icon: ListChecks,
        description: 'Definition of Done verification runs and guard enforcement (OMN-5200)',
      },
      {
        title: 'Event Bus Health',
        url: '/event-bus-health',
        icon: Server,
        description: 'Consumer lag, DLQ traffic, missing topics per Redpanda topic (OMN-3192)',
      },
      {
        title: 'Topic Topology',
        url: '/topic-topology',
        icon: Network,
        description: 'Graph of Kafka topic producers flowing into the omnidash consumer (OMN-5294)',
      },
      {
        title: 'Runtime Health',
        url: '/worker-health',
        icon: Container,
        description:
          'Container status, restart counts, Docker healthcheck for runtime workers (OMN-3598)',
      },
      {
        title: 'LLM Health',
        url: '/llm-health',
        icon: Cpu,
        description:
          'Per-endpoint LLM latency, error rate, and throughput from health snapshot events (OMN-5279)',
      },
      {
        title: 'DLQ Monitor',
        url: '/dlq',
        icon: AlertTriangle,
        description:
          'Dead-letter queue failures: failed messages, error categories, retry counts (OMN-5287)',
      },
      {
        title: 'Circuit Breaker',
        url: '/circuit-breaker',
        icon: Zap,
        description:
          'Infra circuit breaker state transitions — CLOSED / OPEN / HALF_OPEN per service (OMN-5293)',
      },
      {
        title: 'Feature Flags',
        url: '/feature-flags',
        icon: ToggleLeft,
        description:
          'Contract-declared feature flags with runtime state and toggle controls (OMN-5582)',
      },
      {
        title: 'Consumer Health',
        url: '/consumer-health',
        icon: HeartPulse,
        description:
          'Kafka consumer heartbeat failures, session timeouts, and rebalance events (OMN-5527)',
      },
      {
        title: 'Runtime Errors',
        url: '/runtime-errors',
        icon: Bug,
        description: 'Structured runtime errors captured from allowlisted loggers (OMN-5528)',
      },
      {
        title: 'Gate Decisions',
        url: '/gate-decisions',
        icon: ShieldCheck,
        description: 'Merge gate verdicts with reasoning and override history',
      },
      {
        title: 'Debug Escalation',
        url: '/debug-escalation',
        icon: Bug,
        description: 'Escalated debug sessions requiring human attention',
      },
      {
        title: 'Status',
        url: '/status',
        icon: Activity,
        description: 'GitHub PR and Linear ticket snapshot overview',
      },
      {
        title: 'Wiring Health',
        url: '/wiring-health',
        icon: Network,
        description: 'Cross-repo wiring completeness and gap detection (OMN-5292)',
      },
      {
        title: 'Compliance',
        url: '/compliance',
        icon: ShieldAlert,
        description: 'Contract compliance status and violation tracking (OMN-5285)',
      },
      {
        title: 'Agents',
        url: '/agents',
        icon: Bot,
        description: 'Registered agent inventory and runtime status (OMN-6753)',
      },
      {
        title: 'Contract Drift',
        url: '/drift',
        icon: GitCompare,
        description: 'Cross-repo contract drift detection from onex_change_control (OMN-6753)',
      },
      {
        title: 'Pipeline',
        url: '/pipeline',
        icon: Workflow,
        description: 'Unified pipeline health and status overview (OMN-6753)',
      },
      {
        title: 'Wiring Status',
        url: '/wiring-status',
        icon: Activity,
        description: 'Pipeline wiring status for all dashboard pages (OMN-6975)',
      },
    ],
  },
  {
    label: 'Tools',
    items: [
      {
        title: 'Correlation Trace',
        url: '/trace',
        icon: Search,
        description: 'Trace events by correlation ID',
      },
      {
        title: 'Learned Insights',
        url: '/insights',
        icon: Lightbulb,
        description: 'Patterns and conventions from OmniClaude sessions',
      },
      {
        title: 'Settings',
        url: '/settings',
        icon: Settings,
        description: 'Runtime environment configuration and system info (OMN-6753)',
      },
    ],
  },
  {
    label: 'Preview',
    items: [
      {
        title: 'Widget Showcase',
        url: '/showcase',
        icon: Layers,
        description: 'All 5 contract-driven widget types',
      },
    ],
  },
];

/** All advanced-section URLs for determining whether the section should auto-expand. */
const advancedUrls = advancedSubGroups.flatMap((g) => g.items.map((i) => i.url));

/**
 * Returns true if the current location matches an advanced-section route.
 *
 * NOTE: The root path '/' is treated as an alias for '/events' (Event Stream).
 * It maps to the Advanced section, not to any category dashboard. If a
 * dashboard landing page is added in the future, this alias and the
 * corresponding isActive check below should be revisited.
 */
function isAdvancedRoute(location: string): boolean {
  const normalized = location.split(/[?#]/)[0];
  return advancedUrls.some(
    (url) =>
      normalized === url ||
      (url === '/events' && normalized === '/') ||
      normalized.startsWith(`${url}/`)
  );
}

/** Props for {@link NavGroup}. */
interface NavGroupProps {
  label: string;
  items: NavItem[];
  location: string;
}

/** Renders a labelled sidebar group with active-route highlighting. */
function NavGroup({ label, items, location }: NavGroupProps) {
  return (
    <SidebarGroup>
      <SidebarGroupLabel className="text-xs uppercase tracking-wider px-3 mb-2">
        {label}
      </SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => {
            const normalizedLocation = location.split(/[?#]/)[0];
            const isActive =
              normalizedLocation === item.url || normalizedLocation.startsWith(`${item.url}/`);
            return (
              <SidebarMenuItem key={item.title}>
                <SidebarMenuButton
                  asChild
                  tooltip={item.description}
                  className={cn('group', isActive && 'bg-sidebar-accent')}
                  data-testid={`nav-${item.url.slice(1).replace(/\//g, '-')}`}
                >
                  <Link href={item.url}>
                    <item.icon className="w-4 h-4" />
                    <span>{item.title}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

/** Props for {@link AdvancedNavSection}. */
interface AdvancedNavSectionProps {
  location: string;
  /** When true, show all pages regardless of wiring status (demo/dev mode). */
  showAll?: boolean;
}

/**
 * Filter advanced sub-groups by wiring status.
 * Pages with status 'working' or 'partial' are always shown.
 * Pages with 'preview', 'stub', or 'missing' are hidden unless showAll is true.
 * Empty groups after filtering are omitted entirely.
 */
function filterSubGroups(groups: AdvancedSubGroup[], showAll: boolean): AdvancedSubGroup[] {
  if (showAll) return groups;
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => isRouteVisible(item.url)),
    }))
    .filter((group) => group.items.length > 0);
}

/** Wiring status badge for partial-status pages. */
function WiringBadge({ url }: { url: string }) {
  const status = getRouteWiringStatus(url);
  if (status === 'partial') {
    return (
      <span
        className="ml-auto text-[9px] font-medium px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 uppercase tracking-wider"
        data-testid={`wiring-badge-${url.slice(1)}`}
      >
        Partial
      </span>
    );
  }
  return null;
}

/** Collapsible Advanced section containing all granular drill-down pages. */
function AdvancedNavSection({ location, showAll = false }: AdvancedNavSectionProps) {
  const hasActiveChild = isAdvancedRoute(location);
  const [isOpen, setIsOpen] = useState(hasActiveChild);

  // Auto-expand when navigating to an advanced route.
  // Intentionally one-way: we only auto-expand, never auto-collapse.
  // If the user opens the section manually and then navigates to a
  // category dashboard, the section stays open so they can quickly
  // switch back without re-opening it.
  useEffect(() => {
    if (hasActiveChild) {
      setIsOpen(true);
    }
  }, [hasActiveChild]);

  const filteredGroups = filterSubGroups(advancedSubGroups, showAll);

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} data-testid="advanced-section">
      <SidebarGroup>
        <CollapsibleTrigger className="w-full" data-testid="advanced-section-trigger">
          <SidebarGroupLabel className="text-xs uppercase tracking-wider px-3 mb-2 cursor-pointer hover:text-sidebar-foreground transition-colors w-full">
            <Wrench className="w-3.5 h-3.5 mr-1.5" />
            <span>Advanced</span>
            <ChevronDown className="w-3.5 h-3.5 ml-auto transition-transform duration-200 [[data-state=closed]_&]:-rotate-90" />
          </SidebarGroupLabel>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <SidebarGroupContent>
            {filteredGroups.map((subGroup, groupIdx) => (
              <div key={subGroup.label}>
                {groupIdx > 0 && <SidebarSeparator className="my-1" />}
                <div className="px-3 py-1.5">
                  <span className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-medium">
                    {subGroup.label}
                  </span>
                </div>
                <SidebarMenu>
                  {subGroup.items.map((item) => {
                    const normalizedLocation = location.split(/[?#]/)[0];
                    const isActive =
                      normalizedLocation === item.url ||
                      (item.url === '/events' && normalizedLocation === '/') ||
                      normalizedLocation.startsWith(`${item.url}/`);
                    return (
                      <SidebarMenuItem key={item.title}>
                        <SidebarMenuButton
                          asChild
                          tooltip={item.description}
                          className={cn('group pl-5', isActive && 'bg-sidebar-accent')}
                          data-testid={`nav-${item.url.slice(1).replace(/\//g, '-')}`}
                        >
                          <Link href={item.url}>
                            <item.icon className="w-4 h-4" />
                            <span>{item.title}</span>
                            {isActive ? (
                              <ChevronRight className="w-4 h-4 ml-auto text-sidebar-accent-foreground" />
                            ) : (
                              <WiringBadge url={item.url} />
                            )}
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </div>
            ))}
          </SidebarGroupContent>
        </CollapsibleContent>
      </SidebarGroup>
    </Collapsible>
  );
}

/** Primary application sidebar with category dashboards and collapsible Advanced section. */
export function AppSidebar() {
  const [location] = useLocation();
  const { isDemoMode, toggleDemoMode } = useDemoMode();

  return (
    <Sidebar>
      <SidebarContent>
        <NavGroup label="Dashboards" items={categories} location={location} />
        <AdvancedNavSection location={location} showAll={isDemoMode} />
      </SidebarContent>

      <SidebarFooter className="p-2">
        <SidebarSeparator className="mb-2" />
        <button
          onClick={toggleDemoMode}
          className={cn(
            'flex items-center gap-2 w-full px-3 py-2 text-sm rounded-md transition-colors',
            isDemoMode
              ? 'text-amber-400 bg-amber-500/10 hover:bg-amber-500/20'
              : 'text-muted-foreground hover:text-foreground hover:bg-accent'
          )}
          data-testid="demo-mode-toggle"
        >
          <FlaskConical className="h-4 w-4 flex-shrink-0" />
          <span>Demo Mode</span>
          {isDemoMode && <span className="ml-auto text-xs text-amber-400/70">ON</span>}
        </button>
      </SidebarFooter>
    </Sidebar>
  );
}
