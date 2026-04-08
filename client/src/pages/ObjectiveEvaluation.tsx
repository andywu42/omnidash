// SPDX-License-Identifier: MIT
/**
 * Objective Evaluation Dashboard (OMN-2583)
 *
 * Four panels:
 *   1. Score Vector — Radar chart per agent (6 dimensions: correctness, safety,
 *      cost, latency, maintainability, human_time). Never collapsed to scalar.
 *   2. Gate Failure Timeline — Time-series by GateType with drill-down to
 *      EvaluationResult and attribution_refs.
 *   3. Policy State History — Reliability/confidence over time per PolicyType,
 *      lifecycle transitions and auto-blacklist events on timeline.
 *   4. Anti-Gaming Alert Feed — Live Goodhart/reward-hacking/distributional-shift
 *      alerts with acknowledge/dismiss.
 *
 * Data: PostgreSQL via /api/objective/* endpoints.
 * Falls back to realistic mock data when DB is unavailable (OMN-2545, OMN-2557
 * backend PRs may not be merged yet in all envs).
 */

import { useState, useCallback } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  Radar,
  Legend,
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  LineChart,
  Line,
} from 'recharts';
import { TOOLTIP_STYLE_SM } from '@/lib/constants/chart-theme';
import {
  RefreshCw,
  ShieldAlert,
  AlertTriangle,
  TrendingUp,
  CheckCircle2,
  XCircle,
  Activity,
  Target,
  Layers,
  Eye,
  BellOff,
  AlertCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { objectiveSource } from '@/lib/data-sources/objective-source';
import type {
  ObjectiveTimeWindow,
  GateFailureEvent,
  PolicyStatePoint,
  AntiGamingAlert,
  GateType,
  PolicyLifecycleState,
} from '@shared/objective-types';
import { format, parseISO } from 'date-fns';
import { queryKeys } from '@/lib/query-keys';

// ============================================================================
// Constants
// ============================================================================

const TIME_WINDOWS: { value: ObjectiveTimeWindow; label: string }[] = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: 'all', label: 'All' },
];

/** Correctness and safety always highest visual priority (lexicographic ordering). */
const SCORE_DIMENSIONS = [
  { key: 'correctness', label: 'Correctness', color: '#ef4444' },
  { key: 'safety', label: 'Safety', color: '#f97316' },
  { key: 'cost', label: 'Cost', color: '#3b82f6' },
  { key: 'latency', label: 'Latency', color: '#8b5cf6' },
  { key: 'maintainability', label: 'Maintainability', color: '#10b981' },
  { key: 'human_time', label: 'Human Time', color: '#06b6d4' },
] as const;

const GATE_TYPE_COLORS: Record<GateType, string> = {
  safety_hard: '#ef4444',
  safety_soft: '#f97316',
  correctness: '#eab308',
  cost_budget: '#3b82f6',
  latency_budget: '#8b5cf6',
  maintainability: '#10b981',
  human_time: '#06b6d4',
  custom: '#6b7280',
};

const LIFECYCLE_BADGE: Record<
  PolicyLifecycleState,
  { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }
> = {
  candidate: { label: 'Candidate', variant: 'secondary' },
  validated: { label: 'Validated', variant: 'default' },
  promoted: { label: 'Promoted', variant: 'default' },
  deprecated: { label: 'Deprecated', variant: 'destructive' },
};

const ALERT_TYPE_LABELS: Record<string, string> = {
  goodhart_violation: 'Goodhart Violation',
  reward_hacking: 'Reward Hacking',
  distributional_shift: 'Distributional Shift',
};

const ALERT_TYPE_ICONS: Record<string, React.ReactNode> = {
  goodhart_violation: <Target className="h-4 w-4 text-red-500" />,
  reward_hacking: <TrendingUp className="h-4 w-4 text-orange-500" />,
  distributional_shift: <Activity className="h-4 w-4 text-yellow-500" />,
};

// ============================================================================
// Sub-components
// ============================================================================

// ============================================================================
// Panel 1: Score Vector (Radar Chart)
// ============================================================================

function ScoreVectorPanel({ window }: { window: ObjectiveTimeWindow }) {
  const [selectedAgent, setSelectedAgent] = useState<string>('all');

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.objective.scoreVector(window),
    queryFn: () => objectiveSource.scoreVector(window),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const radarData = SCORE_DIMENSIONS.map((dim) => {
    const entry: Record<string, number | string> = { dimension: dim.label };
    (data?.aggregates ?? []).forEach((agg) => {
      if (selectedAgent === 'all' || agg.context_label === selectedAgent) {
        entry[agg.context_label] = Number(
          (agg.scores[dim.key as keyof typeof agg.scores] * 100).toFixed(1)
        );
      }
    });
    return entry;
  });

  const visibleAgents =
    selectedAgent === 'all'
      ? (data?.aggregates ?? []).map((a) => a.context_label)
      : [selectedAgent];

  const agentColors = ['#ef4444', '#3b82f6', '#10b981', '#f97316', '#8b5cf6', '#06b6d4'];

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Layers className="h-4 w-4 text-muted-foreground" />
              Score Vector
            </CardTitle>
            <CardDescription className="text-xs mt-0.5">
              Per-layer dimensions — correctness and safety always highest priority. Never collapsed
              to scalar.
            </CardDescription>
          </div>
          <Select value={selectedAgent} onValueChange={setSelectedAgent}>
            <SelectTrigger className="w-36 h-8 text-xs">
              <SelectValue placeholder="All agents" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All agents</SelectItem>
              {(data?.agents ?? []).map((a) => (
                <SelectItem key={a} value={a}>
                  {a}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : error ? (
          <div className="h-64 flex items-center justify-center text-muted-foreground text-sm">
            <XCircle className="h-4 w-4 mr-2" />
            Failed to load score vector data
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <RadarChart data={radarData}>
              <PolarGrid />
              <PolarAngleAxis dataKey="dimension" tick={{ fontSize: 11 }} />
              <PolarRadiusAxis angle={90} domain={[0, 100]} tick={{ fontSize: 9 }} />
              {visibleAgents.map((agent, idx) => (
                <Radar
                  key={agent}
                  name={agent}
                  dataKey={agent}
                  stroke={agentColors[idx % agentColors.length]}
                  fill={agentColors[idx % agentColors.length]}
                  fillOpacity={0.15}
                  strokeWidth={2}
                />
              ))}
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Tooltip
                formatter={(value: any) => [`${value}%`, '']}
                contentStyle={TOOLTIP_STYLE_SM}
              />
            </RadarChart>
          </ResponsiveContainer>
        )}
        {data && (
          <p className="text-xs text-muted-foreground mt-2 text-center">
            Sample count: {data.aggregates.reduce((s, a) => s + a.sample_count, 0)} evaluations
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Panel 2: Gate Failure Timeline
// ============================================================================

function GateFailureTimelinePanel({ window }: { window: ObjectiveTimeWindow }) {
  const [drilldownEvent, setDrilldownEvent] = useState<GateFailureEvent | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.objective.gateFailures(window),
    queryFn: () => objectiveSource.gateFailureTimeline(window),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  // Build stacked area data
  const chartData = (data?.bins ?? []).map((bin) => {
    const entry: Record<string, string | number> = {
      ts:
        window === '24h'
          ? format(parseISO(bin.bin_start), 'HH:mm')
          : format(parseISO(bin.bin_start), 'MMM d'),
      total: bin.total,
    };
    Object.entries(bin.by_gate_type).forEach(([gt, count]) => {
      entry[gt] = count;
    });
    return entry;
  });

  const gateTypes = Object.keys(data?.totals_by_gate_type ?? {}) as GateType[];

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldAlert className="h-4 w-4 text-muted-foreground" />
                Gate Failure Timeline
              </CardTitle>
              <CardDescription className="text-xs mt-0.5">
                Failures by gate type over time. Click a row to drill down to EvaluationResult.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              {data && data.total_failures > 0 && (
                <Badge variant="destructive" className="text-xs">
                  {data.total_failures} failures
                </Badge>
              )}
              {data && data.escalating_sessions.length > 0 && (
                <Badge variant="outline" className="text-xs border-orange-500 text-orange-600">
                  {data.escalating_sessions.length} escalating
                </Badge>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-48 w-full" />
          ) : error ? (
            <div className="h-48 flex items-center justify-center text-muted-foreground text-sm">
              <XCircle className="h-4 w-4 mr-2" />
              Failed to load gate failure data
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="ts" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE_SM}
                  formatter={(v: any, name: any) => [v, name.replace(/_/g, ' ')]}
                />
                <Legend wrapperStyle={{ fontSize: 10 }} formatter={(v) => v.replace(/_/g, ' ')} />
                {gateTypes.map((gt) => (
                  <Area
                    key={gt}
                    type="monotone"
                    dataKey={gt}
                    stackId="1"
                    stroke={GATE_TYPE_COLORS[gt]}
                    fill={GATE_TYPE_COLORS[gt]}
                    fillOpacity={0.6}
                    strokeWidth={1.5}
                  />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          )}

          {/* Drill-down table: most recent failures */}
          {(data?.events ?? []).length > 0 && (
            <div className="mt-4">
              <p className="text-xs font-medium text-muted-foreground mb-2">
                Recent failures (click to inspect)
              </p>
              <div className="overflow-auto max-h-48">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs py-1">Time</TableHead>
                      <TableHead className="text-xs py-1">Gate</TableHead>
                      <TableHead className="text-xs py-1">Agent</TableHead>
                      <TableHead className="text-xs py-1">Score / Threshold</TableHead>
                      <TableHead className="text-xs py-1"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(data?.events ?? []).slice(0, 15).map((evt) => (
                      <TableRow
                        key={evt.evaluation_id}
                        className={cn(
                          'cursor-pointer hover:bg-muted/50 transition-colors',
                          evt.increased_vs_prev_window && 'bg-orange-500/5'
                        )}
                        onClick={() => setDrilldownEvent(evt)}
                      >
                        <TableCell className="text-xs py-1 font-mono">
                          {format(parseISO(evt.occurred_at), 'MM/dd HH:mm')}
                        </TableCell>
                        <TableCell className="text-xs py-1">
                          <span
                            className="px-1.5 py-0.5 rounded text-white text-[10px]"
                            style={{ backgroundColor: GATE_TYPE_COLORS[evt.gate_type] }}
                          >
                            {evt.gate_type.replace(/_/g, ' ')}
                          </span>
                        </TableCell>
                        <TableCell className="text-xs py-1 font-mono">{evt.agent_name}</TableCell>
                        <TableCell className="text-xs py-1 font-mono text-red-500">
                          {evt.score_value.toFixed(2)} / {evt.threshold.toFixed(2)}
                        </TableCell>
                        <TableCell className="text-xs py-1">
                          {evt.increased_vs_prev_window && (
                            <TrendingUp className="h-3 w-3 text-orange-500" />
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Drill-down dialog */}
      <Dialog open={!!drilldownEvent} onOpenChange={() => setDrilldownEvent(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-red-500" />
              EvaluationResult — Gate Failure
            </DialogTitle>
            <DialogDescription>
              {drilldownEvent && format(parseISO(drilldownEvent.occurred_at), 'PPpp')}
            </DialogDescription>
          </DialogHeader>
          {drilldownEvent && (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <p className="text-xs text-muted-foreground">Evaluation ID</p>
                  <p className="font-mono text-xs">{drilldownEvent.evaluation_id}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Session</p>
                  <p className="font-mono text-xs">{drilldownEvent.session_id}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Gate Type</p>
                  <span
                    className="px-2 py-0.5 rounded text-white text-xs"
                    style={{ backgroundColor: GATE_TYPE_COLORS[drilldownEvent.gate_type] }}
                  >
                    {drilldownEvent.gate_type.replace(/_/g, ' ')}
                  </span>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Agent</p>
                  <p className="font-mono text-xs">{drilldownEvent.agent_name}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Score</p>
                  <p className="text-red-500 font-mono text-xs">
                    {drilldownEvent.score_value.toFixed(4)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Threshold</p>
                  <p className="font-mono text-xs">{drilldownEvent.threshold.toFixed(4)}</p>
                </div>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Attribution Refs</p>
                <div className="space-y-1">
                  {drilldownEvent.attribution_refs.map((ref) => (
                    <p key={ref} className="font-mono text-xs bg-muted px-2 py-1 rounded">
                      {ref}
                    </p>
                  ))}
                </div>
              </div>
              {drilldownEvent.increased_vs_prev_window && (
                <Alert className="py-2">
                  <TrendingUp className="h-3 w-3 text-orange-500" />
                  <AlertDescription className="text-xs">
                    Gate failures for this session increased vs. the previous window.
                  </AlertDescription>
                </Alert>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

// ============================================================================
// Panel 3: Policy State History
// ============================================================================

function PolicyStateHistoryPanel({ window }: { window: ObjectiveTimeWindow }) {
  const [selectedPolicy, setSelectedPolicy] = useState<string>('all');
  const [drilldownPoint, setDrilldownPoint] = useState<PolicyStatePoint | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.objective.policyState(window),
    queryFn: () => objectiveSource.policyStateHistory(window),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const filteredPoints = (data?.points ?? []).filter(
    (p) => selectedPolicy === 'all' || p.policy_id === selectedPolicy
  );

  // Build chart data per policy
  const policyIds = selectedPolicy === 'all' ? (data?.policy_ids ?? []) : [selectedPolicy];
  const policyColors = ['#3b82f6', '#10b981', '#8b5cf6', '#f97316'];

  const chartData = filteredPoints
    .map((p) => ({
      ts:
        window === '24h'
          ? format(parseISO(p.recorded_at), 'HH:mm')
          : format(parseISO(p.recorded_at), 'MMM d'),
      [`${p.policy_id}_reliability`]: Number((p.reliability_0_1 * 100).toFixed(1)),
      [`${p.policy_id}_confidence`]: Number((p.confidence_0_1 * 100).toFixed(1)),
      is_transition: p.is_transition,
      is_auto_blacklist: p.is_auto_blacklist,
      raw: p,
    }))
    .slice(-50); // cap for readability

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Eye className="h-4 w-4 text-muted-foreground" />
                Policy State History
              </CardTitle>
              <CardDescription className="text-xs mt-0.5">
                Reliability and confidence over time. Lifecycle transitions and auto-blacklist
                events are marked on the timeline.
              </CardDescription>
            </div>
            <Select value={selectedPolicy} onValueChange={setSelectedPolicy}>
              <SelectTrigger className="w-44 h-8 text-xs">
                <SelectValue placeholder="All policies" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All policies</SelectItem>
                {(data?.policy_ids ?? []).map((id) => (
                  <SelectItem key={id} value={id}>
                    {id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-48 w-full" />
          ) : error ? (
            <div className="h-48 flex items-center justify-center text-muted-foreground text-sm">
              <XCircle className="h-4 w-4 mr-2" />
              Failed to load policy state data
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="ts" tick={{ fontSize: 10 }} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} unit="%" />
                <Tooltip contentStyle={TOOLTIP_STYLE_SM} formatter={(v: any) => [`${v}%`, '']} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                {policyIds.flatMap((pid, idx) => [
                  <Line
                    key={`${pid}_reliability`}
                    type="monotone"
                    dataKey={`${pid}_reliability`}
                    name={`${pid} reliability`}
                    stroke={policyColors[idx % policyColors.length]}
                    strokeWidth={2}
                    dot={
                      ((props: {
                        cx: number;
                        cy: number;
                        payload: { is_auto_blacklist?: boolean; is_transition?: boolean };
                      }) => {
                        if (props.payload.is_auto_blacklist) {
                          return (
                            <circle
                              key={`${props.cx}-${props.cy}`}
                              cx={props.cx}
                              cy={props.cy}
                              r={6}
                              fill="#ef4444"
                              stroke="white"
                              strokeWidth={1.5}
                              style={{ cursor: 'pointer' }}
                            />
                          );
                        }
                        if (props.payload.is_transition) {
                          return (
                            <circle
                              key={`${props.cx}-${props.cy}`}
                              cx={props.cx}
                              cy={props.cy}
                              r={4}
                              fill={policyColors[idx % policyColors.length]}
                              stroke="white"
                              strokeWidth={1.5}
                            />
                          );
                        }
                        return (
                          <circle
                            key={`${props.cx}-${props.cy}`}
                            cx={props.cx}
                            cy={props.cy}
                            r={0}
                          />
                        );
                      }) as any
                    }
                  />,
                  <Line
                    key={`${pid}_confidence`}
                    type="monotone"
                    dataKey={`${pid}_confidence`}
                    name={`${pid} confidence`}
                    stroke={policyColors[idx % policyColors.length]}
                    strokeWidth={1.5}
                    strokeDasharray="4 2"
                    dot={false}
                  />,
                ])}
              </LineChart>
            </ResponsiveContainer>
          )}

          {/* Current states table */}
          {(data?.current_states ?? []).length > 0 && (
            <div className="mt-4">
              <p className="text-xs font-medium text-muted-foreground mb-2">Current States</p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs py-1">Policy</TableHead>
                    <TableHead className="text-xs py-1">Type</TableHead>
                    <TableHead className="text-xs py-1">Lifecycle</TableHead>
                    <TableHead className="text-xs py-1">Reliability</TableHead>
                    <TableHead className="text-xs py-1">Confidence</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(data?.current_states ?? []).map((s) => (
                    <TableRow key={s.policy_id}>
                      <TableCell className="text-xs py-1 font-mono">{s.policy_id}</TableCell>
                      <TableCell className="text-xs py-1">{s.policy_type}</TableCell>
                      <TableCell className="text-xs py-1">
                        <Badge
                          variant={LIFECYCLE_BADGE[s.lifecycle_state].variant}
                          className="text-[10px]"
                        >
                          {LIFECYCLE_BADGE[s.lifecycle_state].label}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs py-1 font-mono">
                        {(s.reliability_0_1 * 100).toFixed(1)}%
                      </TableCell>
                      <TableCell className="text-xs py-1 font-mono">
                        {(s.confidence_0_1 * 100).toFixed(1)}%
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {/* Auto-blacklist and tool_degraded events inline */}
          {filteredPoints.some((p) => p.is_auto_blacklist || p.has_tool_degraded_alert) && (
            <div className="mt-3 space-y-2">
              {filteredPoints
                .filter((p) => p.is_auto_blacklist || p.has_tool_degraded_alert)
                .slice(0, 5)
                .map((p) => (
                  <Alert
                    key={`${p.policy_id}-${p.recorded_at}`}
                    className={cn(
                      'py-2',
                      p.is_auto_blacklist && 'border-red-500/50 bg-red-500/10',
                      p.has_tool_degraded_alert &&
                        !p.is_auto_blacklist &&
                        'border-yellow-500/50 bg-yellow-500/10'
                    )}
                  >
                    <AlertCircle
                      className={cn(
                        'h-3 w-3',
                        p.is_auto_blacklist ? 'text-red-500' : 'text-yellow-500'
                      )}
                    />
                    <AlertDescription className="text-xs">
                      <span className="font-medium">{p.policy_id}</span>
                      {p.is_auto_blacklist && ' — auto-blacklisted'}
                      {p.has_tool_degraded_alert && ` — ${p.tool_degraded_message}`}
                      <span className="ml-2 text-muted-foreground font-mono">
                        {format(parseISO(p.recorded_at), 'MMM d HH:mm')}
                      </span>
                    </AlertDescription>
                  </Alert>
                ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Drill-down dialog (placeholder for now) */}
      <Dialog open={!!drilldownPoint} onOpenChange={() => setDrilldownPoint(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Policy State Detail</DialogTitle>
          </DialogHeader>
          {drilldownPoint && (
            <pre className="text-xs bg-muted p-3 rounded overflow-auto">
              {JSON.stringify(drilldownPoint, null, 2)}
            </pre>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

// ============================================================================
// Panel 4: Anti-Gaming Alert Feed
// ============================================================================

function AntiGamingAlertFeed({ window }: { window: ObjectiveTimeWindow }) {
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.objective.antiGaming(window),
    queryFn: () => objectiveSource.antiGamingAlerts(window),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  const acknowledgeMutation = useMutation({
    mutationFn: (alertId: string) => objectiveSource.acknowledgeAlert(alertId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.objective.antiGaming(window) });
    },
  });

  const unacknowledged = (data?.alerts ?? []).filter((a) => !a.acknowledged);
  const acknowledged = (data?.alerts ?? []).filter((a) => a.acknowledged);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-4 w-4 text-muted-foreground" />
              Anti-Gaming Alert Feed
            </CardTitle>
            <CardDescription className="text-xs mt-0.5">
              Goodhart violations, reward hacking, and distributional shift alerts.
            </CardDescription>
          </div>
          {data && data.total_unacknowledged > 0 && (
            <Badge variant="destructive" className="text-xs">
              {data.total_unacknowledged} unacknowledged
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : error ? (
          <div className="h-24 flex items-center justify-center text-muted-foreground text-sm">
            <XCircle className="h-4 w-4 mr-2" />
            Failed to load alert feed
          </div>
        ) : (data?.alerts ?? []).length === 0 ? (
          <div className="h-24 flex items-center justify-center text-muted-foreground text-sm">
            <CheckCircle2 className="h-4 w-4 mr-2 text-green-500" />
            No alerts in this window
          </div>
        ) : (
          <div className="space-y-2 max-h-[480px] overflow-auto pr-1">
            {/* Unacknowledged first */}
            {unacknowledged.map((alert) => (
              <AlertCard
                key={alert.alert_id}
                alert={alert}
                onAcknowledge={() => acknowledgeMutation.mutate(alert.alert_id)}
                acknowledging={
                  acknowledgeMutation.isPending && acknowledgeMutation.variables === alert.alert_id
                }
              />
            ))}
            {/* Acknowledged (dimmed) */}
            {acknowledged.map((alert) => (
              <AlertCard key={alert.alert_id} alert={alert} acknowledged />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AlertCard({
  alert,
  onAcknowledge,
  acknowledging = false,
  acknowledged = false,
}: {
  alert: AntiGamingAlert;
  onAcknowledge?: () => void;
  acknowledging?: boolean;
  acknowledged?: boolean;
}) {
  return (
    <div
      className={cn(
        'border rounded-md p-3 text-sm transition-opacity',
        acknowledged ? 'opacity-50' : 'border-red-500/30 bg-red-500/5'
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2 min-w-0">
          <span className="mt-0.5 shrink-0">{ALERT_TYPE_ICONS[alert.alert_type]}</span>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="outline" className="text-[10px] shrink-0">
                {ALERT_TYPE_LABELS[alert.alert_type] ?? alert.alert_type}
              </Badge>
              <span className="font-mono text-xs text-muted-foreground">
                {format(parseISO(alert.triggered_at), 'MMM d HH:mm')}
              </span>
            </div>
            <p className="text-xs mt-1 text-muted-foreground leading-relaxed">
              {alert.description}
            </p>
            <div className="flex items-center gap-3 mt-1">
              <span className="text-xs">
                <span className="text-muted-foreground">Metric:</span>{' '}
                <span className="font-mono">{alert.metric_name}</span>
                <span className="text-muted-foreground mx-1">vs</span>
                <span className="font-mono">{alert.proxy_metric}</span>
              </span>
              <span
                className={cn(
                  'text-xs font-mono',
                  alert.delta > 0 ? 'text-red-500' : 'text-green-500'
                )}
              >
                Δ{alert.delta > 0 ? '+' : ''}
                {(alert.delta * 100).toFixed(1)}%
              </span>
            </div>
          </div>
        </div>
        {!acknowledged && onAcknowledge && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs shrink-0"
            onClick={onAcknowledge}
            disabled={acknowledging}
          >
            {acknowledging ? (
              <RefreshCw className="h-3 w-3 animate-spin" />
            ) : (
              <BellOff className="h-3 w-3" />
            )}
            <span className="ml-1">Ack</span>
          </Button>
        )}
        {acknowledged && <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0 mt-0.5" />}
      </div>
    </div>
  );
}

// ============================================================================
// Main Page
// ============================================================================

export default function ObjectiveEvaluation() {
  const queryClient = useQueryClient();
  const [timeWindow, setTimeWindow] = useState<ObjectiveTimeWindow>('7d');

  const handleRefreshAll = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.objective.all });
  }, [queryClient]);

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Target className="h-5 w-5 text-muted-foreground" />
            Objective Evaluation
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Score vectors, gate failures, policy state, and anti-gaming alerts. No scalar reward
            values are shown.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex border rounded-md overflow-hidden">
            {TIME_WINDOWS.map((tw) => (
              <button
                key={tw.value}
                onClick={() => setTimeWindow(tw.value)}
                className={cn(
                  'px-3 py-1.5 text-xs font-medium transition-colors',
                  timeWindow === tw.value
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-background hover:bg-muted text-muted-foreground'
                )}
              >
                {tw.label}
              </button>
            ))}
          </div>
          <Button size="sm" variant="outline" onClick={handleRefreshAll}>
            <RefreshCw className="h-3 w-3 mr-1" />
            Refresh
          </Button>
        </div>
      </div>

      {/* Panel layout: 2-column grid on large screens */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <ScoreVectorPanel window={timeWindow} />
        <GateFailureTimelinePanel window={timeWindow} />
        <PolicyStateHistoryPanel window={timeWindow} />
        <AntiGamingAlertFeed window={timeWindow} />
      </div>
    </div>
  );
}
