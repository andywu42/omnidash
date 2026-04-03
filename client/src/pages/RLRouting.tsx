/**
 * RL Routing Comparison Dashboard (OMN-5570)
 *
 * Compares learned (shadow) routing policy with static rules:
 * 1. Agreement rate (NOT primary metric -- context matters more)
 * 2. Disagreement breakdown by task type / cost tier / latency budget
 * 3. Estimated reward delta of learned vs static recommendations
 * 4. Latency/cost difference for matched comparable requests
 * 5. Endpoint distribution entropy / concentration of learned recommendations
 * 6. Top disagreement scenarios (where learned policy diverges most)
 *
 * Shadow-to-promotion gate criteria displayed on dashboard:
 * - Minimum sample threshold: >= 100 shadow decisions
 * - Estimated reward delta is positive overall
 * - No critical scenario bucket shows materially worse cost/latency tradeoffs
 * - Endpoint concentration: no single endpoint > 80% of shadow recommendations
 * - Shadow recommendations don't exhibit unstable action selection
 * - Top disagreement scenarios manually reviewed and accepted
 *
 * Events consumed from: routing_shadow_decisions table
 * (projected from Kafka events emitted by Bifrost gateway shadow mode)
 */

import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useFeatureStaleness } from '@/hooks/useStaleness';
import { StalenessIndicator } from '@/components/StalenessIndicator';
import { buildApiUrl } from '@/lib/data-sources/api-base';
// Query keys are inlined (no entry in query-keys.ts until API endpoints land)
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  GitFork,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  BarChart3,
  Zap,
  Shield,
  Activity,
} from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { cn } from '@/lib/utils';
import { POLLING_INTERVAL_MEDIUM } from '@/lib/constants/query-config';

// ============================================================================
// Types
// ============================================================================

interface ShadowSummary {
  total_decisions: number;
  agreement_count: number;
  disagreement_count: number;
  agreement_rate: number;
  avg_shadow_confidence: number;
  avg_shadow_latency_ms: number;
  policy_version: string;
}

interface DisagreementBreakdown {
  dimension: string;
  value: string;
  total: number;
  disagreements: number;
  disagreement_rate: number;
}

interface RewardDelta {
  overall_cost_delta: number;
  overall_latency_delta_ms: number;
  estimated_reward_delta: number;
  sample_count: number;
}

interface EndpointDistribution {
  backend_id: string;
  shadow_count: number;
  static_count: number;
  shadow_pct: number;
  static_pct: number;
}

interface TopDisagreement {
  static_backend: string;
  shadow_backend: string;
  operation_type: string;
  cost_tier: string;
  count: number;
  avg_shadow_confidence: number;
  avg_cost_delta: number | null;
  avg_latency_delta_ms: number | null;
}

interface PromotionGate {
  name: string;
  passed: boolean;
  detail: string;
}

// ============================================================================
// Mock data generators (replaced by API when shadow mode is active)
// ============================================================================

function generateMockSummary(): ShadowSummary {
  return {
    total_decisions: 0,
    agreement_count: 0,
    disagreement_count: 0,
    agreement_rate: 0,
    avg_shadow_confidence: 0,
    avg_shadow_latency_ms: 0,
    policy_version: 'no-policy-loaded',
  };
}

function generateMockDisagreementBreakdown(): DisagreementBreakdown[] {
  return [];
}

function generateMockRewardDelta(): RewardDelta {
  return {
    overall_cost_delta: 0,
    overall_latency_delta_ms: 0,
    estimated_reward_delta: 0,
    sample_count: 0,
  };
}

function generateMockEndpointDistribution(): EndpointDistribution[] {
  return [];
}

function generateMockTopDisagreements(): TopDisagreement[] {
  return [];
}

// ============================================================================
// Promotion gate evaluation
// ============================================================================

const MIN_SAMPLE_THRESHOLD = 100;
const MAX_ENDPOINT_CONCENTRATION = 0.8;

function evaluatePromotionGates(
  summary: ShadowSummary,
  rewardDelta: RewardDelta,
  endpointDist: EndpointDistribution[],
  topDisagreements: TopDisagreement[]
): PromotionGate[] {
  const gates: PromotionGate[] = [];

  // Gate 1: Minimum sample threshold
  gates.push({
    name: 'Minimum Sample Threshold',
    passed: summary.total_decisions >= MIN_SAMPLE_THRESHOLD,
    detail: `${summary.total_decisions} / ${MIN_SAMPLE_THRESHOLD} decisions`,
  });

  // Gate 2: Estimated reward delta is positive
  gates.push({
    name: 'Positive Reward Delta',
    passed: rewardDelta.estimated_reward_delta > 0,
    detail:
      rewardDelta.estimated_reward_delta > 0
        ? `+${rewardDelta.estimated_reward_delta.toFixed(4)} estimated reward`
        : `${rewardDelta.estimated_reward_delta.toFixed(4)} estimated reward (negative)`,
  });

  // Gate 3: No critical scenario with worse cost/latency
  const worstScenario = topDisagreements.find(
    (d) =>
      d.avg_cost_delta !== null &&
      d.avg_cost_delta > 0 &&
      d.avg_latency_delta_ms !== null &&
      d.avg_latency_delta_ms > 0
  );
  gates.push({
    name: 'No Critical Scenario Regression',
    passed: !worstScenario,
    detail: worstScenario
      ? `${worstScenario.operation_type}/${worstScenario.cost_tier}: worse cost AND latency`
      : 'No scenario shows worse cost AND latency',
  });

  // Gate 4: Endpoint concentration < 80%
  const maxConcentration = endpointDist.reduce((max, d) => Math.max(max, d.shadow_pct), 0);
  gates.push({
    name: 'Endpoint Concentration',
    passed: maxConcentration < MAX_ENDPOINT_CONCENTRATION * 100,
    detail: `Max endpoint: ${maxConcentration.toFixed(1)}% (limit: ${MAX_ENDPOINT_CONCENTRATION * 100}%)`,
  });

  // Gate 5: Stable action selection (low confidence variance)
  gates.push({
    name: 'Stable Action Selection',
    passed: summary.avg_shadow_confidence > 0.5,
    detail: `Avg confidence: ${(summary.avg_shadow_confidence * 100).toFixed(1)}%`,
  });

  // Gate 6: Top disagreements reviewed (manual)
  gates.push({
    name: 'Top Disagreements Reviewed',
    passed: false, // Always manual
    detail: 'Requires manual review of top disagreement scenarios',
  });

  return gates;
}

// ============================================================================
// Colors
// ============================================================================

const _CHART_COLORS = [
  '#3b82f6',
  '#22c55e',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#06b6d4',
  '#f97316',
  '#ec4899',
  '#14b8a6',
  '#6366f1',
];

// ============================================================================
// Component
// ============================================================================

export default function RLRouting() {
  const [timeWindow, setTimeWindow] = useState<string>('24h');
  const rlEpisodesLastUpdated = useFeatureStaleness('rl-episodes');

  // Fetch shadow summary
  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: ['rl-routing', 'summary', timeWindow],
    queryFn: async () => {
      try {
        const res = await fetch(
          buildApiUrl(`/api/intelligence/rl-routing/summary?window=${timeWindow}`)
        );
        if (!res.ok) return generateMockSummary();
        return (await res.json()) as ShadowSummary;
      } catch {
        return generateMockSummary();
      }
    },
    refetchInterval: POLLING_INTERVAL_MEDIUM,
  });

  // Fetch disagreement breakdown
  const { data: disagreementBreakdown } = useQuery({
    queryKey: ['rl-routing', 'disagreements', timeWindow],
    queryFn: async () => {
      try {
        const res = await fetch(
          buildApiUrl(`/api/intelligence/rl-routing/disagreements?window=${timeWindow}`)
        );
        if (!res.ok) return generateMockDisagreementBreakdown();
        return (await res.json()) as DisagreementBreakdown[];
      } catch {
        return generateMockDisagreementBreakdown();
      }
    },
    refetchInterval: POLLING_INTERVAL_MEDIUM,
  });

  // Fetch reward delta
  const { data: rewardDelta } = useQuery({
    queryKey: ['rl-routing', 'reward-delta', timeWindow],
    queryFn: async () => {
      try {
        const res = await fetch(
          buildApiUrl(`/api/intelligence/rl-routing/reward-delta?window=${timeWindow}`)
        );
        if (!res.ok) return generateMockRewardDelta();
        return (await res.json()) as RewardDelta;
      } catch {
        return generateMockRewardDelta();
      }
    },
    refetchInterval: POLLING_INTERVAL_MEDIUM,
  });

  // Fetch endpoint distribution
  const { data: endpointDistribution } = useQuery({
    queryKey: ['rl-routing', 'endpoint-distribution', timeWindow],
    queryFn: async () => {
      try {
        const res = await fetch(
          buildApiUrl(`/api/intelligence/rl-routing/endpoint-distribution?window=${timeWindow}`)
        );
        if (!res.ok) return generateMockEndpointDistribution();
        return (await res.json()) as EndpointDistribution[];
      } catch {
        return generateMockEndpointDistribution();
      }
    },
    refetchInterval: POLLING_INTERVAL_MEDIUM,
  });

  // Fetch top disagreements
  const { data: topDisagreements } = useQuery({
    queryKey: ['rl-routing', 'top-disagreements', timeWindow],
    queryFn: async () => {
      try {
        const res = await fetch(
          buildApiUrl(`/api/intelligence/rl-routing/top-disagreements?window=${timeWindow}`)
        );
        if (!res.ok) return generateMockTopDisagreements();
        return (await res.json()) as TopDisagreement[];
      } catch {
        return generateMockTopDisagreements();
      }
    },
    refetchInterval: POLLING_INTERVAL_MEDIUM,
  });

  const s = summary ?? generateMockSummary();
  const rd = rewardDelta ?? generateMockRewardDelta();
  const ed = endpointDistribution ?? generateMockEndpointDistribution();
  const td = topDisagreements ?? generateMockTopDisagreements();
  const db = disagreementBreakdown ?? generateMockDisagreementBreakdown();

  // Evaluate promotion gates
  const promotionGates = useMemo(() => evaluatePromotionGates(s, rd, ed, td), [s, rd, ed, td]);
  const gatesPassed = promotionGates.filter((g) => g.passed).length;
  const gatesTotal = promotionGates.length;

  // Split disagreement breakdown by dimension
  const byOperationType = db.filter((d) => d.dimension === 'operation_type');
  const byCostTier = db.filter((d) => d.dimension === 'cost_tier');

  const noData = s.total_decisions === 0;

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">RL Routing Comparison</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Learned policy shadow mode vs static routing rules
          </p>
        </div>
        <div className="flex items-center gap-3">
          <StalenessIndicator lastUpdated={rlEpisodesLastUpdated} label="RL Episodes" />
          <Badge variant="outline" className="font-mono text-xs">
            Policy: {s.policy_version}
          </Badge>
          <Select value={timeWindow} onValueChange={setTimeWindow}>
            <SelectTrigger className="w-[100px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1h">1h</SelectItem>
              <SelectItem value="24h">24h</SelectItem>
              <SelectItem value="7d">7d</SelectItem>
              <SelectItem value="30d">30d</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* No data banner */}
      {noData && (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Shadow mode inactive</AlertTitle>
          <AlertDescription>
            No shadow decisions recorded. Enable shadow mode in Bifrost gateway config with a loaded
            policy checkpoint to begin comparison.
          </AlertDescription>
        </Alert>
      )}

      {/* Row 1: Summary metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-4">
        <MetricCard
          title="Total Decisions"
          value={s.total_decisions.toLocaleString()}
          icon={<Activity className="h-4 w-4" />}
          loading={summaryLoading}
        />
        <MetricCard
          title="Agreement Rate"
          value={`${(s.agreement_rate * 100).toFixed(1)}%`}
          subtitle="Not primary metric"
          icon={<GitFork className="h-4 w-4" />}
          loading={summaryLoading}
        />
        <MetricCard
          title="Reward Delta"
          value={
            rd.estimated_reward_delta > 0
              ? `+${rd.estimated_reward_delta.toFixed(4)}`
              : rd.estimated_reward_delta.toFixed(4)
          }
          icon={
            rd.estimated_reward_delta >= 0 ? (
              <TrendingUp className="h-4 w-4 text-green-500" />
            ) : (
              <TrendingDown className="h-4 w-4 text-red-500" />
            )
          }
          loading={summaryLoading}
          highlight={
            rd.estimated_reward_delta > 0
              ? 'green'
              : rd.estimated_reward_delta < 0
                ? 'red'
                : undefined
          }
        />
        <MetricCard
          title="Cost Delta"
          value={`${rd.overall_cost_delta >= 0 ? '+' : ''}${rd.overall_cost_delta.toFixed(4)}`}
          subtitle={rd.overall_cost_delta < 0 ? 'Shadow saves cost' : 'Shadow costs more'}
          icon={<Zap className="h-4 w-4" />}
          loading={summaryLoading}
        />
        <MetricCard
          title="Latency Delta"
          value={`${rd.overall_latency_delta_ms >= 0 ? '+' : ''}${rd.overall_latency_delta_ms.toFixed(1)}ms`}
          subtitle={rd.overall_latency_delta_ms < 0 ? 'Shadow is faster' : 'Shadow is slower'}
          icon={<BarChart3 className="h-4 w-4" />}
          loading={summaryLoading}
        />
        <MetricCard
          title="Shadow Latency"
          value={`${s.avg_shadow_latency_ms.toFixed(1)}ms`}
          subtitle="< 5ms target"
          icon={<Zap className="h-4 w-4" />}
          loading={summaryLoading}
          highlight={s.avg_shadow_latency_ms > 5 ? 'red' : 'green'}
        />
      </div>

      {/* Row 2: Promotion Gate + Endpoint Distribution */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Promotion Gate */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Shield className="h-4 w-4" />
              Shadow-to-Promotion Gate
            </CardTitle>
            <CardDescription>
              {gatesPassed}/{gatesTotal} criteria met
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {promotionGates.map((gate) => (
                <div
                  key={gate.name}
                  className="flex items-center justify-between py-1.5 border-b border-border/50 last:border-0"
                >
                  <div className="flex items-center gap-2">
                    {gate.passed ? (
                      <CheckCircle2 className="h-4 w-4 text-green-500" />
                    ) : (
                      <XCircle className="h-4 w-4 text-red-500" />
                    )}
                    <span className="text-sm font-medium">{gate.name}</span>
                  </div>
                  <span className="text-xs text-muted-foreground max-w-[200px] truncate">
                    {gate.detail}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Endpoint Distribution (Metric 5) */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Endpoint Distribution</CardTitle>
            <CardDescription>Shadow vs static backend selection frequency</CardDescription>
          </CardHeader>
          <CardContent>
            {ed.length > 0 ? (
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={ed} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis type="number" domain={[0, 100]} tickFormatter={(v) => `${v}%`} />
                  <YAxis dataKey="backend_id" type="category" width={100} tick={{ fontSize: 12 }} />
                  <Tooltip
                    formatter={(value: any) => `${value.toFixed(1)}%`}
                    contentStyle={{
                      background: 'hsl(var(--card))',
                      border: '1px solid hsl(var(--border))',
                    }}
                  />
                  <Legend />
                  <Bar dataKey="shadow_pct" name="Shadow" fill="#3b82f6" radius={[0, 4, 4, 0]} />
                  <Bar dataKey="static_pct" name="Static" fill="#6b7280" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-[250px] text-muted-foreground text-sm">
                No endpoint distribution data
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Row 3: Disagreement Breakdown (Metric 2) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Disagreement by Operation Type</CardTitle>
            <CardDescription>Where learned policy diverges from static rules</CardDescription>
          </CardHeader>
          <CardContent>
            {byOperationType.length > 0 ? (
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={byOperationType}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="value" tick={{ fontSize: 11 }} />
                  <YAxis tickFormatter={(v) => `${(v * 100).toFixed(0)}%`} domain={[0, 1]} />
                  <Tooltip
                    formatter={(value: any) => `${(value * 100).toFixed(1)}%`}
                    contentStyle={{
                      background: 'hsl(var(--card))',
                      border: '1px solid hsl(var(--border))',
                    }}
                  />
                  <Bar
                    dataKey="disagreement_rate"
                    name="Disagreement Rate"
                    fill="#f59e0b"
                    radius={[4, 4, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-[250px] text-muted-foreground text-sm">
                No disagreement data by operation type
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Disagreement by Cost Tier</CardTitle>
            <CardDescription>Divergence pattern across cost sensitivity levels</CardDescription>
          </CardHeader>
          <CardContent>
            {byCostTier.length > 0 ? (
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={byCostTier}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="value" tick={{ fontSize: 11 }} />
                  <YAxis tickFormatter={(v) => `${(v * 100).toFixed(0)}%`} domain={[0, 1]} />
                  <Tooltip
                    formatter={(value: any) => `${(value * 100).toFixed(1)}%`}
                    contentStyle={{
                      background: 'hsl(var(--card))',
                      border: '1px solid hsl(var(--border))',
                    }}
                  />
                  <Bar
                    dataKey="disagreement_rate"
                    name="Disagreement Rate"
                    fill="#8b5cf6"
                    radius={[4, 4, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-[250px] text-muted-foreground text-sm">
                No disagreement data by cost tier
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Row 4: Top Disagreement Scenarios (Metric 6) */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Top Disagreement Scenarios</CardTitle>
          <CardDescription>
            Most frequent divergence patterns between static and learned routing
          </CardDescription>
        </CardHeader>
        <CardContent>
          {td.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Static Backend</TableHead>
                  <TableHead>Shadow Backend</TableHead>
                  <TableHead>Operation</TableHead>
                  <TableHead>Cost Tier</TableHead>
                  <TableHead className="text-right">Count</TableHead>
                  <TableHead className="text-right">Confidence</TableHead>
                  <TableHead className="text-right">Cost Delta</TableHead>
                  <TableHead className="text-right">Latency Delta</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {td.map((d, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-mono text-xs">{d.static_backend}</TableCell>
                    <TableCell className="font-mono text-xs">{d.shadow_backend}</TableCell>
                    <TableCell>{d.operation_type}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs">
                        {d.cost_tier}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">{d.count}</TableCell>
                    <TableCell className="text-right">
                      {(d.avg_shadow_confidence * 100).toFixed(1)}%
                    </TableCell>
                    <TableCell
                      className={cn(
                        'text-right',
                        d.avg_cost_delta !== null && d.avg_cost_delta < 0
                          ? 'text-green-500'
                          : d.avg_cost_delta !== null && d.avg_cost_delta > 0
                            ? 'text-red-500'
                            : ''
                      )}
                    >
                      {d.avg_cost_delta !== null ? d.avg_cost_delta.toFixed(4) : '--'}
                    </TableCell>
                    <TableCell
                      className={cn(
                        'text-right',
                        d.avg_latency_delta_ms !== null && d.avg_latency_delta_ms < 0
                          ? 'text-green-500'
                          : d.avg_latency_delta_ms !== null && d.avg_latency_delta_ms > 0
                            ? 'text-red-500'
                            : ''
                      )}
                    >
                      {d.avg_latency_delta_ms !== null
                        ? `${d.avg_latency_delta_ms.toFixed(1)}ms`
                        : '--'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="flex items-center justify-center h-[100px] text-muted-foreground text-sm">
              No disagreement scenarios recorded
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ============================================================================
// MetricCard subcomponent
// ============================================================================

function MetricCard({
  title,
  value,
  subtitle,
  icon,
  loading,
  highlight,
}: {
  title: string;
  value: string;
  subtitle?: string;
  icon?: React.ReactNode;
  loading?: boolean;
  highlight?: 'green' | 'red';
}) {
  if (loading) {
    return (
      <Card>
        <CardContent className="p-4">
          <Skeleton className="h-4 w-20 mb-2" />
          <Skeleton className="h-8 w-16" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
          {icon}
          {title}
        </div>
        <div
          className={cn(
            'text-xl font-semibold tabular-nums',
            highlight === 'green' && 'text-green-500',
            highlight === 'red' && 'text-red-500'
          )}
        >
          {value}
        </div>
        {subtitle && <div className="text-xs text-muted-foreground mt-0.5">{subtitle}</div>}
      </CardContent>
    </Card>
  );
}
