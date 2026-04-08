/**
 * LLM Routing Effectiveness Dashboard (OMN-2279)
 *
 * Compares LLM routing vs fuzzy routing effectiveness:
 * - Agreement rate (GOLDEN METRIC — target >60%, alert if LLM disagrees >40%)
 * - Latency distribution per routing method
 * - Fallback frequency
 * - Cost per routing decision
 * - Longitudinal comparison by routing_prompt_version
 * - Top disagreement pairs table
 * - Fuzzy confidence distribution chart (OMN-3447)
 * - Model switcher dropdown (OMN-3447)
 * - Prompt version bump button (OMN-3447)
 *
 * Events consumed from: onex.evt.omniclaude.llm-routing-decision.v1
 */

import { useState, useCallback, useEffect } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useFeatureStaleness } from '@/hooks/useStaleness';
import { StalenessIndicator } from '@/components/StalenessIndicator';
import {
  llmRoutingSource,
  fetchByModel,
  fetchByOmninodeMode,
  fetchFuzzyConfidence,
  fetchRoutingConfig,
  putRoutingConfig,
} from '@/lib/data-sources/llm-routing-source';
import { buildApiUrl } from '@/lib/data-sources/api-base';
import { queryKeys } from '@/lib/query-keys';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
  RefreshCw,
  GitFork,
  AlertTriangle,
  CheckCircle2,
  Clock,
  DollarSign,
  BarChart3,
  AlertCircle,
  TrendingUp,
  Zap,
  Cpu,
  ArrowUpCircle,
} from 'lucide-react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  BarChart,
  Bar,
  Cell,
} from 'recharts';
import { ModelSelector } from '@/components/ModelSelector';
import { cn } from '@/lib/utils';
import {
  POLLING_INTERVAL_MEDIUM,
  POLLING_INTERVAL_SLOW,
  getPollingInterval,
} from '@/lib/constants/query-config';
import { TOOLTIP_STYLE, TOOLTIP_STYLE_SM } from '@/lib/constants/chart-theme';
import type {
  LlmRoutingTimeWindow,
  LlmRoutingByModel,
  LlmRoutingByOmninodeMode,
  LlmRoutingDisagreement,
  LlmRoutingFuzzyConfidenceBucket,
} from '@shared/llm-routing-types';

// ============================================================================
// Constants
// ============================================================================

const TIME_WINDOWS: { value: LlmRoutingTimeWindow; label: string }[] = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: 'all', label: 'All' },
];

/** Threshold below which the alert fires (LLM disagrees with fuzzy >40%). */
const DISAGREEMENT_ALERT_THRESHOLD = 0.4;
/** Golden metric target. */
const AGREEMENT_TARGET = 0.6;

const METHOD_COLORS: Record<string, string> = {
  LLM: '#3b82f6',
  Fuzzy: '#8b5cf6',
};

const VERSION_COLORS = ['#22c55e', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4'];

/** Colors for fuzzy confidence bucket bars (sort_key 0–5). */
const CONFIDENCE_BUCKET_COLORS = [
  '#6b7280', // no_data — gray
  '#ef4444', // 0–30% — red
  '#f97316', // 30–50% — orange
  '#eab308', // 50–70% — yellow
  '#22c55e', // 70–90% — green
  '#14b8a6', // 90–100% — teal
];

// ============================================================================
// Helpers
// ============================================================================

function fmtPct(value: number, decimals = 1): string {
  return `${(value * 100).toFixed(decimals)}%`;
}

function fmtCount(n: number): string {
  return n.toLocaleString();
}

function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${ms.toFixed(0)}ms`;
}

function fmtCost(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.001) return `$${(usd * 1_000_000).toFixed(1)}µ`;
  return `$${usd.toFixed(4)}`;
}

function relativeTime(isoTs: string): string {
  if (!isoTs) return 'never';
  const ts = new Date(isoTs).getTime();
  if (isNaN(ts)) return 'never';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Color bucket for agreement rate (0–1). */
function agreementColor(rate: number): string {
  if (rate >= AGREEMENT_TARGET) return 'text-green-500';
  if (rate >= 0.5) return 'text-yellow-500';
  return 'text-red-500';
}

/**
 * Color bucket for a confidence score (0–1).
 * Uses separate thresholds from agreementColor because confidence scores
 * (typically 0.7–0.95) have a different meaningful range than agreement rates.
 */
function confidenceColor(score: number): string {
  if (score >= 0.7) return 'text-green-500';
  if (score >= 0.5) return 'text-yellow-500';
  return 'text-red-500';
}

function agreementBadge(rate: number): 'default' | 'secondary' | 'destructive' {
  if (rate >= AGREEMENT_TARGET) return 'default';
  if (rate >= 0.5) return 'secondary';
  return 'destructive';
}

// ============================================================================
// Sub-components
// ============================================================================

/** Segmented time window selector. */
function WindowSelector({
  value,
  onChange,
}: {
  value: LlmRoutingTimeWindow;
  onChange: (w: LlmRoutingTimeWindow) => void;
}) {
  return (
    <div className="flex rounded-md border border-border overflow-hidden">
      {TIME_WINDOWS.map((w) => (
        <button
          key={w.value}
          type="button"
          onClick={() => onChange(w.value)}
          className={cn(
            'px-3 py-1.5 text-xs font-medium transition-colors',
            value === w.value
              ? 'bg-primary text-primary-foreground'
              : 'bg-background text-muted-foreground hover:bg-muted'
          )}
        >
          {w.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Hero card for the Agreement Rate golden metric.
 * Shows the rate, a trend sparkline, and the target indicator.
 */
function AgreementRateHero({
  rate,
  trend,
  isLoading,
}: {
  rate: number;
  trend: Array<{ date: string; value: number }>;
  isLoading: boolean;
}) {
  const aboveTarget = rate >= AGREEMENT_TARGET;
  return (
    <Card className="col-span-full md:col-span-2 border-2 border-primary/40 bg-primary/5">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <div>
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-primary" />
            Agreement Rate
          </CardTitle>
          <CardDescription className="text-xs mt-0.5">
            Golden Metric — LLM and fuzzy routing select the same agent (target: &gt;60%)
          </CardDescription>
        </div>
        <Badge variant={isLoading ? 'secondary' : agreementBadge(rate)} className="text-xs">
          {isLoading
            ? '...'
            : aboveTarget
              ? 'On Target'
              : rate >= 0.5
                ? 'Below Target'
                : 'Critical'}
        </Badge>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <div className="flex items-end gap-6">
            <div>
              <span className={cn('text-5xl font-bold tabular-nums', agreementColor(rate))}>
                {fmtPct(rate, 0)}
              </span>
              <p className="text-xs text-muted-foreground mt-1">
                LLM / fuzzy agreement · target {fmtPct(AGREEMENT_TARGET, 0)}
              </p>
            </div>
            {trend.length > 0 && (
              <div className="flex-1 h-16">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={trend} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
                    <Line
                      type="monotone"
                      dataKey="value"
                      stroke="hsl(var(--primary))"
                      strokeWidth={2}
                      dot={false}
                    />
                    <Tooltip
                      formatter={(v: any) => [fmtPct(v), 'Agreement Rate']}
                      labelFormatter={(l) => String(l).slice(0, 10)}
                      contentStyle={TOOLTIP_STYLE_SM}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Simple metric stat card. */
function StatCard({
  title,
  value,
  description,
  icon: Icon,
  valueClass,
  isLoading,
}: {
  title: string;
  value: string;
  description?: string;
  icon: React.ElementType;
  valueClass?: string;
  isLoading: boolean;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-8 w-24" />
        ) : (
          <>
            <div className={cn('text-2xl font-bold tabular-nums', valueClass)}>{value}</div>
            {description && <p className="text-xs text-muted-foreground mt-1">{description}</p>}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Top disagreement pairs table. */
function DisagreementsTable({
  disagreements,
  isLoading,
  isError,
}: {
  disagreements: LlmRoutingDisagreement[];
  isLoading: boolean;
  isError: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <GitFork className="h-4 w-4 text-yellow-500" />
          Top Disagreement Pairs
        </CardTitle>
        <CardDescription>
          Agent pairs where LLM and fuzzy routing disagree most frequently
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isError ? (
          <p className="text-sm text-destructive py-4 text-center">
            Failed to load disagreement data.
          </p>
        ) : isLoading ? (
          <div className="space-y-2">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : disagreements.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No disagreements in this window.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>LLM Selection</TableHead>
                <TableHead>Fuzzy Selection</TableHead>
                <TableHead className="text-right">Count</TableHead>
                <TableHead className="text-right">LLM Conf.</TableHead>
                <TableHead className="text-right">Fuzzy Conf.</TableHead>
                <TableHead>Prompt Version</TableHead>
                <TableHead className="text-right">Last Seen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {disagreements.map((d, idx) => (
                <TableRow
                  key={`${d.llm_agent}:${d.fuzzy_agent}:${d.routing_prompt_version}:${idx}`}
                >
                  <TableCell>
                    <span className="font-mono text-xs text-blue-400">{d.llm_agent}</span>
                  </TableCell>
                  <TableCell>
                    <span className="font-mono text-xs text-purple-400">
                      {d.fuzzy_agent || '—'}
                    </span>
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {fmtCount(d.count)}
                  </TableCell>
                  <TableCell className="text-right">
                    <span
                      className={cn('font-mono text-xs', confidenceColor(d.avg_llm_confidence))}
                    >
                      {fmtPct(d.avg_llm_confidence)}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    {d.fuzzy_agent ? (
                      <span
                        className={cn('font-mono text-xs', confidenceColor(d.avg_fuzzy_confidence))}
                      >
                        {fmtPct(d.avg_fuzzy_confidence)}
                      </span>
                    ) : (
                      <span className="font-mono text-xs text-gray-500">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-[10px] px-1 py-0 font-mono">
                      {d.routing_prompt_version}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">
                    {relativeTime(d.occurred_at)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Horizontal bar chart showing agreement rate per model (OMN-3443).
 * Uses VERSION_COLORS[0] (green) as the fill to match the existing palette.
 */
export function ModelEffectivenessChart({ data }: { data: LlmRoutingByModel[] }) {
  if (data.length === 0) {
    return (
      <div className="text-gray-400 text-sm py-8 text-center">No model data available yet</div>
    );
  }
  const chartData = data.map((d) => ({
    model: d.model.split('/').pop() ?? d.model,
    agreement: Math.round(d.agreement_rate * 100),
  }));
  return (
    <ResponsiveContainer width="100%" height={Math.max(200, chartData.length * 48)}>
      <BarChart data={chartData} layout="vertical" margin={{ left: 100, right: 40 }}>
        <XAxis type="number" domain={[0, 100]} tickFormatter={(v: number) => `${v}%`} />
        <YAxis type="category" dataKey="model" width={100} tick={{ fontSize: 11 }} />
        <Tooltip formatter={(v: any) => [`${v}%`, 'Agreement Rate']} contentStyle={TOOLTIP_STYLE} />
        <Bar
          dataKey="agreement"
          name="Agreement Rate"
          fill={VERSION_COLORS[0]}
          radius={[0, 4, 4, 0]}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}

// ============================================================================
// New sub-components (OMN-3447)
// ============================================================================

/**
 * Fuzzy confidence distribution chart.
 * Shows how many routing decisions fall into each fuzzy_confidence range bucket.
 */
function FuzzyConfidenceChart({
  buckets,
  isLoading,
  isError,
}: {
  buckets: LlmRoutingFuzzyConfidenceBucket[];
  isLoading: boolean;
  isError: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-purple-400" />
          Fuzzy Confidence Distribution
        </CardTitle>
        <CardDescription>
          How many routing decisions fall into each fuzzy confidence range
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isError ? (
          <p className="text-sm text-destructive py-4 text-center">
            Failed to load confidence data.
          </p>
        ) : isLoading ? (
          <Skeleton className="h-52 w-full" />
        ) : buckets.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No fuzzy confidence data in this window.
          </p>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={buckets} margin={{ top: 0, right: 16, left: 8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis
                dataKey="bucket"
                tick={{ fontSize: 11 }}
                stroke="hsl(var(--muted-foreground))"
              />
              <YAxis tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
              <Tooltip
                formatter={(v: any) => [v.toLocaleString(), 'Decisions']}
                contentStyle={TOOLTIP_STYLE}
              />
              <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                {buckets.map((b) => (
                  <Cell key={b.bucket} fill={CONFIDENCE_BUCKET_COLORS[b.sort_key] ?? '#6366f1'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Model switcher dropdown.
 * Reads available models from /api/llm-routing/models (30d stable).
 * Reads/writes active model via /api/routing-config/active_routing_model.
 */
function ModelSwitcher() {
  const modelsUrl = buildApiUrl('/api/llm-routing/models');

  const { data: models = [] } = useQuery<string[]>({
    queryKey: ['llm-routing', 'models'],
    queryFn: async () => {
      const res = await fetch(modelsUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<string[]>;
    },
    staleTime: 60_000,
  });

  const { data: activeModel, refetch: refetchActiveModel } = useQuery<string | null>({
    queryKey: ['routing-config', 'active_routing_model'],
    queryFn: () => fetchRoutingConfig('active_routing_model'),
    staleTime: 30_000,
  });

  const mutation = useMutation({
    mutationFn: (model: string) => putRoutingConfig('active_routing_model', model),
    onSuccess: () => void refetchActiveModel(),
  });

  const handleChange = (value: string) => {
    mutation.mutate(value);
  };

  const allModels = models.length > 0 ? models : activeModel ? [activeModel] : [];

  return (
    <div className="flex items-center gap-2">
      <Cpu className="h-4 w-4 text-muted-foreground shrink-0" />
      <span className="text-xs text-muted-foreground whitespace-nowrap">Active Model</span>
      <Select
        value={activeModel ?? ''}
        onValueChange={handleChange}
        disabled={mutation.isPending || allModels.length === 0}
      >
        <SelectTrigger className="h-8 w-44 text-xs">
          <SelectValue placeholder={allModels.length === 0 ? 'No models' : 'Select model'} />
        </SelectTrigger>
        <SelectContent>
          {allModels.map((m) => (
            <SelectItem key={m} value={m} className="text-xs font-mono">
              {m}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {mutation.isPending && <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground" />}
      {mutation.isError && <span className="text-xs text-destructive">Failed to switch model</span>}
    </div>
  );
}

/**
 * Prompt version bump button.
 * Reads routing_prompt_version from routing config, increments the semver patch,
 * and writes back via PUT /api/routing-config/routing_prompt_version.
 */
function PromptBumpButton() {
  const { data: currentVersion, refetch: refetchVersion } = useQuery<string | null>({
    queryKey: ['routing-config', 'routing_prompt_version'],
    queryFn: () => fetchRoutingConfig('routing_prompt_version'),
    staleTime: 30_000,
  });

  const mutation = useMutation({
    mutationFn: async () => {
      const version = currentVersion ?? '1.0.0';
      // Parse semver patch and increment.
      const parts = version.replace(/^v/, '').split('.');
      const major = parseInt(parts[0] ?? '1', 10);
      const minor = parseInt(parts[1] ?? '0', 10);
      const patch = parseInt(parts[2] ?? '0', 10);
      const next = `${major}.${minor}.${patch + 1}`;
      await putRoutingConfig('routing_prompt_version', next);
      return next;
    },
    onSuccess: () => void refetchVersion(),
  });

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={() => mutation.mutate()}
        disabled={mutation.isPending}
        className="text-xs h-8"
      >
        <ArrowUpCircle className="h-3.5 w-3.5 mr-1.5" />
        Bump Prompt
        {currentVersion && (
          <Badge variant="outline" className="ml-2 text-[10px] px-1 py-0 font-mono">
            v{currentVersion}
          </Badge>
        )}
      </Button>
      {mutation.isPending && <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground" />}
      {mutation.isSuccess && (
        <span className="text-xs text-green-500">Bumped to v{mutation.data}</span>
      )}
      {mutation.isError && <span className="text-xs text-destructive">Failed to bump</span>}
    </div>
  );
}

// ============================================================================
// By Model Table (OMN-3449)
// ============================================================================

/** Per-model routing effectiveness including token averages. */
function ByModelTable({
  byModel,
  isLoading,
  isError,
}: {
  byModel: LlmRoutingByModel[];
  isLoading: boolean;
  isError: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-blue-400" />
          Routing by Model
        </CardTitle>
        <CardDescription>
          Agreement rate, latency, cost, and token usage grouped by LLM model
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isError ? (
          <p className="text-sm text-destructive py-4 text-center">
            Failed to load per-model data.
          </p>
        ) : isLoading ? (
          <div className="space-y-2">
            {[...Array(3)].map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : byModel.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No model data in this window.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model</TableHead>
                <TableHead className="text-right">Decisions</TableHead>
                <TableHead className="text-right">Agreement</TableHead>
                <TableHead className="text-right">Avg Latency</TableHead>
                <TableHead className="text-right">Avg Cost</TableHead>
                <TableHead className="text-right">Avg Prompt Tokens</TableHead>
                <TableHead className="text-right">Avg Completion Tokens</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {byModel.map((row) => (
                <TableRow key={row.model}>
                  <TableCell>
                    <span className="font-mono text-xs text-blue-400">{row.model}</span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.total.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    <span
                      className={
                        row.agreement_rate >= 0.6
                          ? 'text-green-500'
                          : row.agreement_rate >= 0.4
                            ? 'text-yellow-500'
                            : 'text-red-500'
                      }
                    >
                      {fmtPct(row.agreement_rate)}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {fmtMs(row.avg_llm_latency_ms)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {fmtCost(row.avg_cost_usd)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.prompt_tokens_avg > 0 ? row.prompt_tokens_avg.toLocaleString() : '—'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.completion_tokens_avg > 0
                      ? row.completion_tokens_avg.toLocaleString()
                      : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Main Dashboard
// ============================================================================

export default function LlmRoutingDashboard() {
  const [timeWindow, setTimeWindow] = useState<LlmRoutingTimeWindow>('7d');
  const [trendModelFilter, setTrendModelFilter] = useState<string | undefined>(undefined);
  const queryClient = useQueryClient();
  const llmRoutingLastUpdated = useFeatureStaleness('llm-routing');

  // Clear singleton mock state on mount so a remount always starts from a
  // clean slate.  Runs before any queries fire (queries are declared below),
  // preventing stale mock flags from a previous mount bleeding into the first
  // render cycle of this mount.
  useEffect(() => {}, []);

  // Invalidate all LLM routing queries on WebSocket LLM_ROUTING_INVALIDATE event
  useWebSocket({
    onMessage: useCallback(
      (msg: { type: string; timestamp: string }) => {
        if (msg.type === 'LLM_ROUTING_INVALIDATE') {
          // Server emits LLM_ROUTING_INVALIDATE via llmRoutingEventEmitter in
          // server/llm-routing-events.ts, triggered by ReadModelConsumer after
          // each successful llm_routing_decisions projection (OMN-2279).
          queryClient.invalidateQueries({ queryKey: queryKeys.llmRouting.all });
        }
      },
      [queryClient]
    ),
    debug: false,
  });

  // ── Queries ──────────────────────────────────────────────────────────────

  const {
    data: summary,
    isLoading: summaryLoading,
    isError: summaryError,
    refetch: refetchSummary,
  } = useQuery({
    queryKey: queryKeys.llmRouting.summary(timeWindow),
    queryFn: () => llmRoutingSource.summary(timeWindow),
    refetchInterval: getPollingInterval(POLLING_INTERVAL_MEDIUM),
    staleTime: 30_000,
  });

  const {
    data: latency,
    isLoading: latencyLoading,
    isError: latencyError,
    refetch: refetchLatency,
  } = useQuery({
    queryKey: queryKeys.llmRouting.latency(timeWindow),
    queryFn: () => llmRoutingSource.latency(timeWindow),
    refetchInterval: getPollingInterval(POLLING_INTERVAL_SLOW),
    staleTime: 60_000,
  });

  const {
    data: byVersion,
    isLoading: versionLoading,
    isError: versionError,
    refetch: refetchVersion,
  } = useQuery({
    queryKey: queryKeys.llmRouting.byVersion(timeWindow),
    queryFn: () => llmRoutingSource.byVersion(timeWindow),
    refetchInterval: getPollingInterval(POLLING_INTERVAL_SLOW),
    staleTime: 60_000,
  });

  const {
    data: disagreements,
    isLoading: disagreementsLoading,
    isError: disagreementsError,
    refetch: refetchDisagreements,
  } = useQuery({
    queryKey: queryKeys.llmRouting.disagreements(timeWindow),
    queryFn: () => llmRoutingSource.disagreements(timeWindow),
    refetchInterval: getPollingInterval(POLLING_INTERVAL_MEDIUM),
    staleTime: 30_000,
  });

  const routingModelsUrl = buildApiUrl('/api/llm-routing/models');
  const { data: routingModels } = useQuery<string[]>({
    queryKey: ['llm-routing', 'models'],
    queryFn: async () => {
      const res = await fetch(routingModelsUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<string[]>;
    },
    staleTime: 60_000,
  });

  const {
    data: trend,
    isLoading: trendLoading,
    isError: trendError,
    refetch: refetchTrend,
  } = useQuery({
    queryKey: [...queryKeys.llmRouting.trend(timeWindow), trendModelFilter ?? 'all'],
    queryFn: () => llmRoutingSource.trend(timeWindow, trendModelFilter),
    refetchInterval: getPollingInterval(POLLING_INTERVAL_SLOW),
    staleTime: 60_000,
  });

  const {
    data: byModel = [],
    isLoading: byModelLoading,
    isError: byModelError,
    refetch: refetchByModel,
  } = useQuery({
    queryKey: queryKeys.llmRouting.byModel(timeWindow),
    queryFn: () => fetchByModel(timeWindow),
    refetchInterval: getPollingInterval(POLLING_INTERVAL_SLOW),
    staleTime: 60_000,
  });

  const {
    data: fuzzyConfidence = [],
    isLoading: fuzzyConfidenceLoading,
    isError: fuzzyConfidenceError,
    refetch: refetchFuzzyConfidence,
  } = useQuery<LlmRoutingFuzzyConfidenceBucket[]>({
    queryKey: [...queryKeys.llmRouting.all, 'fuzzy-confidence', timeWindow],
    queryFn: () => fetchFuzzyConfidence(timeWindow),
    refetchInterval: getPollingInterval(POLLING_INTERVAL_SLOW),
    staleTime: 60_000,
  });

  const {
    data: byOmninodeMode = [],
    isLoading: byOmninodesLoading,
    isError: byOmninodesError,
    refetch: refetchByOmninodeMode,
  } = useQuery<LlmRoutingByOmninodeMode[]>({
    queryKey: queryKeys.llmRouting.byOmninodeMode(timeWindow),
    queryFn: () => fetchByOmninodeMode(timeWindow),
    refetchInterval: getPollingInterval(POLLING_INTERVAL_SLOW),
    staleTime: 60_000,
  });

  // ── Helpers ──────────────────────────────────────────────────────────────

  const handleRefresh = () => {
    void refetchSummary();
    void refetchLatency();
    void refetchVersion();
    void refetchDisagreements();
    void refetchTrend();
    void refetchByModel();
    void refetchFuzzyConfidence();
    void refetchByOmninodeMode();
  };

  // false reads a mutable Set on the singleton.
  // Mock state is only set on network/HTTP errors — empty responses no longer
  // trigger mock fallback (mock-on-empty was removed in OMN-2330).
  const [isUsingMockData, setIsUsingMockData] = useState(false);

  const allSettled =
    !summaryLoading &&
    !latencyLoading &&
    !versionLoading &&
    !disagreementsLoading &&
    !trendLoading &&
    !byModelLoading;

  // Single effect keyed on [allSettled, timeWindow].
  // - When timeWindow changes and queries are not yet settled: clear mock state
  //   so the banner is hidden immediately during in-flight requests.
  // - When all queries are settled: read the mock state to decide whether to
  //   show the banner. The banner only appears when a network/HTTP error caused
  //   a mock fallback; it will not appear for empty-but-successful responses.
  useEffect(() => {
    if (allSettled) {
      setIsUsingMockData(false);
    } else {
      // Queries are in-flight (first load or a window switch that caused a
      // cache miss). Clear and hide the banner until settled.
      setIsUsingMockData(false);
    }
  }, [allSettled, timeWindow]);

  const disagreementRate = summary ? 1 - summary.agreement_rate : 0;
  // Only fire the disagreement alert when fuzzy routing is actually running.
  // If the fallback_rate is very high (≥0.9), fuzzy routing data is unavailable
  // and the disagreement rate is not meaningful.
  // Also suppress the alert when total_decisions is 0: agreement_rate defaults
  // to 0 with no data (0/0 edge case), which would incorrectly read as 100%
  // disagreement. The alert is only meaningful with actual routing decisions.
  const showFuzzyUnavailableBanner =
    !summaryLoading && summary != null && (summary.fallback_rate ?? 0) >= 0.9;
  const showDisagreementAlert =
    !summaryLoading &&
    summary != null &&
    summary.total_decisions > 0 &&
    disagreementRate > DISAGREEMENT_ALERT_THRESHOLD &&
    !showFuzzyUnavailableBanner;

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6" data-testid="page-llm-routing-dashboard">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">LLM Routing Effectiveness</h1>
          <p className="text-muted-foreground">
            Comparing LLM routing vs fuzzy routing agreement, latency, and cost
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <StalenessIndicator lastUpdated={llmRoutingLastUpdated} label="LLM Routing" />
          <ModelSwitcher />
          <PromptBumpButton />
          <WindowSelector value={timeWindow} onChange={setTimeWindow} />
          <Button variant="outline" size="sm" onClick={handleRefresh}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
        </div>
      </div>

      {/* Demo Mode Banner */}
      {isUsingMockData && (
        <Alert variant="default" className="border-yellow-500/50 bg-yellow-500/10">
          <AlertCircle className="h-4 w-4 text-yellow-500" />
          <AlertTitle className="text-yellow-500">Demo Mode</AlertTitle>
          <AlertDescription className="text-muted-foreground">
            Database unavailable or no LLM routing events yet. Showing representative demo data. The
            dashboard will show live data once{' '}
            <code className="text-xs">onex.evt.omniclaude.llm-routing-decision.v1</code> events are
            received.
          </AlertDescription>
        </Alert>
      )}

      {/* Fuzzy Routing Unavailable Banner */}
      {showFuzzyUnavailableBanner && (
        <Alert variant="default" className="border-blue-500/50 bg-blue-500/10">
          <AlertCircle className="h-4 w-4 text-blue-500" />
          <AlertTitle className="text-blue-500">Fuzzy Routing Data Not Yet Available</AlertTitle>
          <AlertDescription className="text-muted-foreground">
            Fuzzy routing was not available for most decisions in this window — agreement rate
            cannot be meaningfully computed. The dashboard will update once fuzzy routing candidates
            are produced.
          </AlertDescription>
        </Alert>
      )}

      {/* Disagreement Alert (golden metric health check) */}
      {showDisagreementAlert && (
        <Alert variant="destructive" className="border-red-500/50 bg-red-500/10">
          <AlertTriangle className="h-4 w-4 text-red-500" />
          <AlertTitle className="text-red-500">High Disagreement Rate Detected</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>
              LLM disagrees with fuzzy routing <strong>{fmtPct(disagreementRate)}</strong> of the
              time (threshold: {fmtPct(DISAGREEMENT_ALERT_THRESHOLD)}). This may indicate a flawed
              routing prompt or a mis-ranked fuzzy matcher.
            </p>
            <p className="text-xs text-muted-foreground">
              Actions: Review the top disagreement pairs below — then use the{' '}
              <strong>Active Model</strong> switcher above to change the routing model, or{' '}
              <strong>Bump Prompt</strong> to increment the prompt version after making corrections.
            </p>
          </AlertDescription>
        </Alert>
      )}

      {/* Error Banner */}
      {summaryError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Failed to load LLM routing data</AlertTitle>
          <AlertDescription>
            <Button variant="outline" size="sm" className="mt-2" onClick={handleRefresh}>
              <RefreshCw className="h-4 w-4 mr-1" /> Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* ── Hero: Agreement Rate + Stat Cards ───────────────────────────── */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {/* Golden metric spans 2 columns */}
        <AgreementRateHero
          rate={summary?.agreement_rate ?? 0}
          trend={summary?.agreement_rate_trend ?? []}
          isLoading={summaryLoading}
        />

        {/* Fallback Rate */}
        <StatCard
          title="Fallback Rate"
          value={summaryLoading ? '—' : fmtPct(summary?.fallback_rate ?? 0)}
          description="Decisions where fuzzy routing was not available or did not produce a candidate."
          icon={Zap}
          valueClass={(summary?.fallback_rate ?? 0) < 0.1 ? 'text-green-500' : 'text-yellow-500'}
          isLoading={summaryLoading}
        />

        {/* Avg Cost per Decision */}
        <StatCard
          title="Avg Cost / Decision"
          value={summaryLoading ? '—' : fmtCost(summary?.avg_cost_usd ?? 0)}
          description="Estimated USD per LLM routing call"
          icon={DollarSign}
          isLoading={summaryLoading}
        />

        {/* Total Decisions */}
        <StatCard
          title="Total Decisions"
          value={summaryLoading ? '—' : fmtCount(summary?.total_decisions ?? 0)}
          description={`${fmtCount(summary?.counts?.disagreed ?? 0)} disagreements`}
          icon={BarChart3}
          isLoading={summaryLoading}
        />

        {/* LLM p50 Latency */}
        <StatCard
          title="LLM p50 Latency"
          value={summaryLoading ? '—' : fmtMs(summary?.llm_p50_latency_ms ?? 0)}
          description={`p95: ${fmtMs(summary?.llm_p95_latency_ms ?? 0)}`}
          icon={Clock}
          valueClass="text-blue-400"
          isLoading={summaryLoading}
        />

        {/* Fuzzy p50 Latency */}
        <StatCard
          title="Fuzzy p50 Latency"
          value={summaryLoading ? '—' : fmtMs(summary?.fuzzy_p50_latency_ms ?? 0)}
          description={`p95: ${fmtMs(summary?.fuzzy_p95_latency_ms ?? 0)}`}
          icon={Clock}
          valueClass="text-purple-400"
          isLoading={summaryLoading}
        />

        {/* Avg Prompt Tokens (OMN-3449) */}
        <StatCard
          title="Avg Prompt Tokens"
          value={summaryLoading ? '—' : fmtCount(summary?.avg_prompt_tokens ?? 0)}
          description="Average prompt tokens per routing decision"
          icon={BarChart3}
          isLoading={summaryLoading}
        />

        {/* Avg Completion Tokens (OMN-3449) */}
        <StatCard
          title="Avg Completion Tokens"
          value={summaryLoading ? '—' : fmtCount(summary?.avg_completion_tokens ?? 0)}
          description="Average completion tokens per routing decision"
          icon={BarChart3}
          isLoading={summaryLoading}
        />
      </div>

      {/* ── Trend Chart ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <TrendingUp className="h-4 w-4" />
                Routing Effectiveness Trends
              </CardTitle>
              <CardDescription>Agreement rate, fallback rate, and cost over time</CardDescription>
            </div>
            <ModelSelector
              value={trendModelFilter ?? null}
              onChange={(m) => setTrendModelFilter(m ?? undefined)}
              className="h-8 w-48 text-xs"
              models={routingModels}
            />
          </div>
        </CardHeader>
        <CardContent>
          {trendError ? (
            <p className="text-sm text-destructive py-8 text-center">Failed to load trend data.</p>
          ) : trendLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : (trend?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No trend data available.
            </p>
          ) : (
            <>
              {(trend?.length ?? 0) === 1 && (
                <p className="text-xs text-muted-foreground mb-3">
                  Only 1 day of data — trend lines need multiple days to render. Showing
                  today&apos;s snapshot.
                </p>
              )}
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={trend} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis
                    dataKey="date"
                    tickFormatter={(v: string) => String(v).slice(5, 10)}
                    tick={{ fontSize: 11 }}
                    stroke="hsl(var(--muted-foreground))"
                  />
                  <YAxis
                    yAxisId="rate"
                    tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`}
                    domain={[0, 1]}
                    tick={{ fontSize: 11 }}
                    stroke="hsl(var(--muted-foreground))"
                  />
                  <YAxis
                    yAxisId="cost"
                    orientation="right"
                    tickFormatter={(v: number) => `$${(v * 1_000_000).toFixed(0)}µ`}
                    domain={[0, 0.0001]}
                    tick={{ fontSize: 11 }}
                    stroke="hsl(var(--muted-foreground))"
                  />
                  <Tooltip
                    formatter={(v: any, name: any) => {
                      if (name === 'avg_cost_usd') return [fmtCost(v), 'Avg Cost'];
                      return [
                        fmtPct(v),
                        name === 'agreement_rate' ? 'Agreement Rate' : 'Fallback Rate',
                      ];
                    }}
                    labelFormatter={(l) => String(l).slice(0, 10)}
                    contentStyle={{
                      fontSize: '12px',
                      backgroundColor: 'hsl(var(--card))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '6px',
                      color: 'hsl(var(--card-foreground))',
                    }}
                  />
                  <Legend
                    formatter={(value) =>
                      value === 'agreement_rate'
                        ? 'Agreement Rate'
                        : value === 'fallback_rate'
                          ? 'Fallback Rate'
                          : 'Avg Cost'
                    }
                  />
                  <Line
                    yAxisId="rate"
                    type="monotone"
                    dataKey="agreement_rate"
                    stroke="#22c55e"
                    strokeWidth={2.5}
                    dot={(trend?.length ?? 0) <= 1 ? { r: 5, fill: '#22c55e' } : false}
                    activeDot={{ r: 5 }}
                  />
                  <Line
                    yAxisId="rate"
                    type="monotone"
                    dataKey="fallback_rate"
                    stroke="#f59e0b"
                    strokeWidth={2}
                    dot={(trend?.length ?? 0) <= 1 ? { r: 5, fill: '#f59e0b' } : false}
                    activeDot={{ r: 5 }}
                    strokeDasharray="4 3"
                  />
                  <Line
                    yAxisId="cost"
                    type="monotone"
                    dataKey="avg_cost_usd"
                    stroke="#ef4444"
                    strokeWidth={1.5}
                    dot={(trend?.length ?? 0) <= 1 ? { r: 4, fill: '#ef4444' } : false}
                    activeDot={{ r: 4 }}
                    strokeDasharray="2 4"
                  />
                </LineChart>
              </ResponsiveContainer>
            </>
          )}
        </CardContent>
      </Card>

      {/* ── Latency Distribution + Version Comparison ────────────────────── */}
      <div className="grid gap-6 md:grid-cols-2">
        {/* Latency Distribution */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="h-4 w-4" />
              Latency Distribution
            </CardTitle>
            <CardDescription>p50 / p95 latency per routing method</CardDescription>
          </CardHeader>
          <CardContent>
            {latencyError ? (
              <p className="text-sm text-destructive py-4 text-center">
                Failed to load latency data.
              </p>
            ) : latencyLoading ? (
              <Skeleton className="h-52 w-full" />
            ) : (latency?.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No data.</p>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={latency} margin={{ top: 0, right: 16, left: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis
                    dataKey="method"
                    tick={{ fontSize: 11 }}
                    stroke="hsl(var(--muted-foreground))"
                  />
                  <YAxis
                    tickFormatter={(v: number) => fmtMs(v)}
                    tick={{ fontSize: 11 }}
                    stroke="hsl(var(--muted-foreground))"
                  />
                  <Tooltip
                    formatter={(v: any, name: any) => [
                      fmtMs(v),
                      name === 'p50_ms'
                        ? 'p50'
                        : name === 'p90_ms'
                          ? 'p90'
                          : name === 'p95_ms'
                            ? 'p95'
                            : 'p99',
                    ]}
                    contentStyle={TOOLTIP_STYLE}
                  />
                  <Legend formatter={(v) => v.replace('_ms', '').toUpperCase()} />
                  <Bar dataKey="p50_ms" radius={[4, 4, 0, 0]}>
                    {(latency ?? []).map((l) => (
                      <Cell key={l.method} fill={METHOD_COLORS[l.method] ?? '#6366f1'} />
                    ))}
                  </Bar>
                  <Bar dataKey="p95_ms" radius={[4, 4, 0, 0]}>
                    {(latency ?? []).map((l) => (
                      <Cell
                        key={l.method}
                        fill={METHOD_COLORS[l.method] ?? '#6366f1'}
                        fillOpacity={0.55}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Agreement Rate by Prompt Version */}
        <Card>
          <CardHeader>
            <CardTitle>Agreement Rate by Prompt Version</CardTitle>
            <CardDescription>
              Longitudinal comparison: improvement across routing_prompt_version releases
            </CardDescription>
          </CardHeader>
          <CardContent>
            {versionError ? (
              <p className="text-sm text-destructive py-4 text-center">
                Failed to load version data.
              </p>
            ) : versionLoading ? (
              <Skeleton className="h-52 w-full" />
            ) : (byVersion?.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No data.</p>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart
                  data={byVersion}
                  layout="vertical"
                  margin={{ top: 0, right: 16, left: 8, bottom: 0 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="hsl(var(--border))"
                    horizontal={false}
                  />
                  <XAxis
                    type="number"
                    domain={[0, 1]}
                    tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`}
                    tick={{ fontSize: 11 }}
                    stroke="hsl(var(--muted-foreground))"
                  />
                  <YAxis
                    type="category"
                    dataKey="routing_prompt_version"
                    tick={{ fontSize: 11 }}
                    width={60}
                    stroke="hsl(var(--muted-foreground))"
                  />
                  <Tooltip
                    formatter={(v: any) => [fmtPct(v), 'Agreement Rate']}
                    contentStyle={TOOLTIP_STYLE}
                  />
                  <Bar dataKey="agreement_rate" radius={[0, 4, 4, 0]}>
                    {(byVersion ?? []).map((_, idx) => (
                      <Cell key={idx} fill={VERSION_COLORS[idx % VERSION_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Fuzzy Confidence Distribution (OMN-3447) ─────────────────────── */}
      <FuzzyConfidenceChart
        buckets={fuzzyConfidence}
        isLoading={fuzzyConfidenceLoading}
        isError={fuzzyConfidenceError}
      />

      {/* ── Routing by Model with Token Averages (OMN-3449) ─────────────── */}
      <ByModelTable byModel={byModel} isLoading={byModelLoading} isError={byModelError} />

      {/* ── OmniNode Path Comparison (OMN-3450) ──────────────────────────── */}
      {byOmninodesError ? null : byOmninodesLoading ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">OmniNode Path Comparison</CardTitle>
          </CardHeader>
          <CardContent>
            <Skeleton className="h-32 w-full" />
          </CardContent>
        </Card>
      ) : byOmninodeMode.length > 0 ? (
        <section className="mt-6 bg-gray-900 rounded-xl p-4">
          <h2 className="text-lg font-semibold mb-1">OmniNode Path Comparison</h2>
          <p className="text-xs text-gray-500 mb-3">
            Compares routing decisions made via the ONEX node pipeline vs legacy path
          </p>
          <div className="grid grid-cols-2 gap-4">
            {byOmninodeMode.map((mode) => (
              <div
                key={String(mode.omninode_enabled)}
                className={cn(
                  'rounded-lg p-3 border',
                  mode.omninode_enabled
                    ? 'border-green-700 bg-green-900/20'
                    : 'border-gray-600 bg-gray-800'
                )}
              >
                <div className="font-semibold mb-2 text-sm">
                  {mode.omninode_enabled ? '✓ ONEX Path' : '○ Legacy Path'}
                </div>
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span className="text-gray-400">Decisions</span>
                    <span className="font-mono tabular-nums">{fmtCount(mode.total)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Agreement Rate</span>
                    <span
                      className={cn('font-mono tabular-nums', agreementColor(mode.agreement_rate))}
                    >
                      {fmtPct(mode.agreement_rate)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Avg Cost</span>
                    <span className="font-mono tabular-nums">{fmtCost(mode.avg_cost_usd)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Avg Tokens</span>
                    <span className="font-mono tabular-nums">
                      {mode.avg_total_tokens > 0 ? fmtCount(mode.avg_total_tokens) : '—'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Avg Latency</span>
                    <span className="font-mono tabular-nums">{fmtMs(mode.avg_llm_latency_ms)}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* ── Top Disagreement Pairs ────────────────────────────────────────── */}
      <DisagreementsTable
        disagreements={disagreements ?? []}
        isLoading={disagreementsLoading}
        isError={disagreementsError}
      />

      {/* ── Per-Model Agreement Rate (OMN-3443) ──────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="h-4 w-4" />
            Agreement Rate by Model
          </CardTitle>
          <CardDescription>
            Horizontal bar chart of LLM vs fuzzy agreement rate per model
          </CardDescription>
        </CardHeader>
        <CardContent>
          {byModelError ? (
            <p className="text-sm text-destructive py-4 text-center">
              Failed to load per-model data.
            </p>
          ) : byModelLoading ? (
            <Skeleton className="h-52 w-full" />
          ) : (
            <ModelEffectivenessChart data={byModel} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
