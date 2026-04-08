/**
 * @module CostTrendDashboard
 *
 * LLM cost and token usage trends with drill-down by model, repo,
 * pattern, and session. Six dashboard views:
 *
 * 1. Cost per session over time (line chart, 24h/7d/30d)
 * 2. Cost by model (bar chart)
 * 3. Cost by repo (bar chart)
 * 4. Cost by pattern (table)
 * 5. Token usage breakdown (stacked bar: prompt vs completion)
 * 6. Budget threshold alerts
 *
 * Defaults to reported-only data (usage_source = API).
 * Toggle enables including estimated data with coverage %.
 * Rows where usage_source = ESTIMATED | MISSING are visually flagged.
 */

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useWebSocket } from '@/hooks/useWebSocket';
import { costSource } from '@/lib/data-sources/cost-source';
import { queryKeys } from '@/lib/query-keys';
import { DemoBanner } from '@/components/DemoBanner';
import { MetricCard } from '@/components/MetricCard';
import { HeroMetric } from '@/components/HeroMetric';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { ModelSelector } from '@/components/ModelSelector';
import { cn } from '@/lib/utils';
import type {
  CostSummary,
  CostTrendPoint,
  CostByModel,
  CostByRepo,
  CostByPattern,
  TokenUsagePoint,
  BudgetAlert,
  CostTimeWindow,
} from '@shared/cost-types';
import {
  DollarSign,
  Coins,
  TrendingDown,
  TrendingUp,
  Cpu,
  GitBranch,
  Layers,
  AlertTriangle,
  Bell,
  BarChart3,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
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

// ============================================================================
// Constants
// ============================================================================

const TIME_WINDOWS: { value: CostTimeWindow; label: string }[] = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
];

/** Bar colors for the cost-by-model chart (cycled by index). */
const MODEL_COLORS = ['#3b82f6', '#8b5cf6', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4'];

/** Bar colors for the cost-by-repo chart (cycled by index). */
const REPO_COLORS = ['#6366f1', '#10b981', '#f97316', '#ec4899', '#14b8a6', '#a855f7'];

// ============================================================================
// Time Window Selector
// ============================================================================

/**
 * Segmented toggle for selecting the dashboard time window (24h / 7d / 30d).
 *
 * @param props - Component props.
 * @param props.value - Currently selected time window.
 * @param props.onChange - Callback fired when the user selects a different window.
 * @returns A row of toggle buttons representing the available time windows.
 */
function WindowSelector({
  value,
  onChange,
}: {
  value: CostTimeWindow;
  onChange: (w: CostTimeWindow) => void;
}) {
  return (
    <div className="flex items-center gap-1 bg-muted rounded-lg p-0.5">
      {TIME_WINDOWS.map((w) => (
        <button
          key={w.value}
          onClick={() => onChange(w.value)}
          className={cn(
            'px-3 py-1 text-xs font-medium rounded-md transition-colors',
            value === w.value
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {w.label}
        </button>
      ))}
    </div>
  );
}

// ============================================================================
// Estimated Data Toggle
// ============================================================================

/**
 * Switch control that toggles inclusion of estimated usage data.
 * When enabled, displays the reported-coverage percentage badge.
 *
 * @param props - Component props.
 * @param props.checked - Whether estimated data is currently included.
 * @param props.onCheckedChange - Callback fired when the switch is toggled.
 * @param props.coveragePct - Percentage of data that is API-reported (shown as badge).
 * @returns A switch with label and an optional coverage-percentage badge.
 */
function EstimatedToggle({
  checked,
  onCheckedChange,
  coveragePct,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  coveragePct?: number;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-2">
        <Switch
          id="include-estimated"
          checked={checked}
          onCheckedChange={onCheckedChange}
          aria-label="Include estimated data"
        />
        <Label htmlFor="include-estimated" className="text-xs text-muted-foreground cursor-pointer">
          Include estimated
        </Label>
      </div>
      {checked && coveragePct !== undefined && (
        <Badge variant="outline" className="text-[10px] font-mono">
          {coveragePct.toFixed(1)}% reported coverage
        </Badge>
      )}
    </div>
  );
}

// ============================================================================
// Usage Source Badge
// ============================================================================

/**
 * Renders a colored badge for ESTIMATED or MISSING usage sources.
 * Returns null for API-reported rows (no badge needed).
 *
 * @param props - Component props.
 * @param props.source - The usage source string (e.g. "API", "ESTIMATED", "MISSING").
 * @returns A colored badge element, or null when the source is "API".
 */
function UsageSourceBadge({ source }: { source: string }) {
  if (source === 'API') return null;
  const isEstimated = source === 'ESTIMATED';
  return (
    <Badge
      className={cn(
        'text-[9px] font-mono',
        isEstimated
          ? 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30'
          : 'bg-red-500/20 text-red-400 border-red-500/30'
      )}
    >
      {source}
    </Badge>
  );
}

// ============================================================================
// 1. Cost Trend Line Chart
// ============================================================================

/**
 * Line chart showing cost over time for the selected window.
 * Always renders a Total line. When `includeEstimated` is true, additionally
 * renders Reported and Estimated lines (dashed for estimated) so users can
 * see the breakdown alongside the total.
 *
 * @param props - Component props.
 * @param props.data - Array of cost trend data points to plot.
 * @param props.includeEstimated - Whether to also show Reported and Estimated breakdown lines.
 * @returns A Recharts line chart, or an empty-state placeholder when data is absent.
 */
function CostTrendChart({
  data,
  includeEstimated,
}: {
  data: CostTrendPoint[] | undefined;
  includeEstimated: boolean;
}) {
  if (!data?.length) {
    return (
      <div className="h-[280px] flex items-center justify-center text-muted-foreground text-sm">
        No trend data available
      </div>
    );
  }

  const chartData = data.map((p) => ({
    time: p.timestamp.length > 10 ? p.timestamp.slice(11, 16) : p.timestamp.slice(5),
    Total: +p.total_cost_usd.toFixed(2),
    ...(includeEstimated
      ? {
          Reported: +p.reported_cost_usd.toFixed(2),
          Estimated: +p.estimated_cost_usd.toFixed(2),
        }
      : {}),
  }));

  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
        <XAxis
          dataKey="time"
          tick={{ fill: 'hsl(var(--foreground))', fontSize: 11, fillOpacity: 0.85 }}
        />
        <YAxis
          tick={{ fill: 'hsl(var(--foreground))', fontSize: 11, fillOpacity: 0.85 }}
          tickFormatter={(v: number) => `$${v.toFixed(0)}`}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: 'hsl(var(--card))',
            border: '1px solid hsl(var(--border))',
            borderRadius: '6px',
            fontSize: '12px',
          }}
          formatter={(value: any, name: any) => [`$${value.toFixed(2)}`, name]}
        />
        <Legend wrapperStyle={{ fontSize: '12px' }} />
        <Line type="monotone" dataKey="Total" stroke="#3b82f6" strokeWidth={2} dot={false} />
        {includeEstimated && (
          <>
            <Line type="monotone" dataKey="Reported" stroke="#22c55e" strokeWidth={2} dot={false} />
            <Line
              type="monotone"
              dataKey="Estimated"
              stroke="#f59e0b"
              strokeWidth={2}
              strokeDasharray="5 5"
              dot={false}
            />
          </>
        )}
      </LineChart>
    </ResponsiveContainer>
  );
}

// ============================================================================
// 2. Cost by Model Bar Chart
// ============================================================================

/**
 * Bar chart ranking total cost by LLM model.
 * Each bar is color-coded using the {@link MODEL_COLORS} palette.
 *
 * @param props - Component props.
 * @param props.data - Array of per-model cost breakdowns.
 * @returns A Recharts bar chart, or an empty-state placeholder when data is absent.
 */
function CostByModelChart({ data }: { data: CostByModel[] | undefined }) {
  if (!data?.length) {
    return (
      <div className="h-[280px] flex items-center justify-center text-muted-foreground text-sm">
        No model data available
      </div>
    );
  }

  const chartData = data.map((m) => ({
    model: m.model_name,
    cost: +m.total_cost_usd.toFixed(2),
  }));

  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
        <XAxis
          dataKey="model"
          tick={{ fill: 'hsl(var(--foreground))', fontSize: 10, fillOpacity: 0.85 }}
          angle={-20}
          textAnchor="end"
          height={60}
        />
        <YAxis
          tick={{ fill: 'hsl(var(--foreground))', fontSize: 11, fillOpacity: 0.85 }}
          tickFormatter={(v: number) => `$${v}`}
        />
        <Tooltip
          cursor={{ fill: 'hsl(var(--muted))' }}
          contentStyle={{
            backgroundColor: 'hsl(var(--card))',
            border: '1px solid hsl(var(--border))',
            borderRadius: '6px',
            fontSize: '12px',
          }}
          formatter={(value: any) => [`$${value.toFixed(2)}`, 'Cost']}
        />
        <Bar dataKey="cost" radius={[4, 4, 0, 0]}>
          {chartData.map((_, index) => (
            <Cell key={`cell-${index}`} fill={MODEL_COLORS[index % MODEL_COLORS.length]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// ============================================================================
// 3. Cost by Repo Bar Chart
// ============================================================================

/**
 * Bar chart ranking total cost by repository.
 * Each bar is color-coded using the {@link REPO_COLORS} palette.
 *
 * @param props - Component props.
 * @param props.data - Array of per-repo cost breakdowns.
 * @returns A Recharts bar chart, or an empty-state placeholder when data is absent.
 */
function CostByRepoChart({ data }: { data: CostByRepo[] | undefined }) {
  if (!data?.length) {
    return (
      <div className="h-[280px] flex items-center justify-center text-muted-foreground text-sm">
        No repo data available
      </div>
    );
  }

  const chartData = data.map((r) => ({
    repo: r.repo_name,
    cost: +r.total_cost_usd.toFixed(2),
  }));

  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
        <XAxis
          dataKey="repo"
          tick={{ fill: 'hsl(var(--foreground))', fontSize: 10, fillOpacity: 0.85 }}
          angle={-20}
          textAnchor="end"
          height={60}
        />
        <YAxis
          tick={{ fill: 'hsl(var(--foreground))', fontSize: 11, fillOpacity: 0.85 }}
          tickFormatter={(v: number) => `$${v}`}
        />
        <Tooltip
          cursor={{ fill: 'hsl(var(--muted))' }}
          contentStyle={{
            backgroundColor: 'hsl(var(--card))',
            border: '1px solid hsl(var(--border))',
            borderRadius: '6px',
            fontSize: '12px',
          }}
          formatter={(value: any) => [`$${value.toFixed(2)}`, 'Cost']}
        />
        <Bar dataKey="cost" radius={[4, 4, 0, 0]}>
          {chartData.map((_, index) => (
            <Cell key={`cell-${index}`} fill={REPO_COLORS[index % REPO_COLORS.length]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// ============================================================================
// 4. Cost by Pattern Table
// ============================================================================

/** Sortable columns in the cost-by-pattern table. */
type PatternSortColumn = 'cost' | 'tokens' | 'injections' | 'avg_cost';

/** Sort direction for table columns. */
type SortDirection = 'asc' | 'desc';

/**
 * Extracts the numeric sort value for a given column from a pattern row.
 *
 * @param row - The cost-by-pattern data row.
 * @param col - The column key to extract a numeric value for.
 * @returns The numeric value used for sorting.
 */
function getPatternSortValue(row: CostByPattern, col: PatternSortColumn): number {
  switch (col) {
    case 'cost':
      return row.total_cost_usd;
    case 'tokens':
      return row.prompt_tokens + row.completion_tokens;
    case 'injections':
      return row.injection_count;
    case 'avg_cost':
      return row.avg_cost_per_injection;
  }
}

/**
 * Sortable table showing per-pattern costs, token counts, and injection frequency.
 * Rows with estimated or missing usage data are visually flagged with a
 * yellow background tint and warning icon.
 *
 * Headers for numeric columns are clickable to toggle ascending/descending sort.
 * The active sort column displays an arrow indicator. Defaults to cost descending.
 *
 * @param props - Component props.
 * @param props.data - Array of per-pattern cost breakdowns with usage source metadata.
 * @returns A sortable HTML table, or an empty-state message when data is absent.
 */
function CostByPatternTable({ data }: { data: CostByPattern[] | undefined }) {
  const [sortColumn, setSortColumn] = useState<PatternSortColumn>('cost');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  const sortedData = useMemo(() => {
    if (!data?.length) return data;
    return [...data].sort((a, b) => {
      const aVal = getPatternSortValue(a, sortColumn);
      const bVal = getPatternSortValue(b, sortColumn);
      return sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
    });
  }, [data, sortColumn, sortDirection]);

  if (!sortedData?.length) {
    return (
      <div className="py-8 text-center text-muted-foreground text-sm">
        No pattern data available
      </div>
    );
  }

  /** Toggles sort on a column: if already active, flips direction; otherwise sets desc. */
  const handleSort = (col: PatternSortColumn) => {
    if (sortColumn === col) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortColumn(col);
      setSortDirection('desc');
    }
  };

  /** Renders the sort indicator icon for a given column header. */
  const SortIcon = ({ col }: { col: PatternSortColumn }) => {
    if (sortColumn !== col) {
      return <ArrowUpDown className="w-3 h-3 opacity-40" />;
    }
    return sortDirection === 'asc' ? (
      <ArrowUp className="w-3 h-3" />
    ) : (
      <ArrowDown className="w-3 h-3" />
    );
  };

  const sortableThClass =
    'text-right py-2 px-3 text-xs uppercase tracking-wider text-muted-foreground font-medium cursor-pointer select-none hover:text-foreground transition-colors';

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className="text-left py-2 px-3 text-xs uppercase tracking-wider text-muted-foreground font-medium">
              Pattern
            </th>
            <th className={sortableThClass} onClick={() => handleSort('cost')}>
              <span className="inline-flex items-center justify-end gap-1">
                Cost <SortIcon col="cost" />
              </span>
            </th>
            <th className={sortableThClass} onClick={() => handleSort('tokens')}>
              <span className="inline-flex items-center justify-end gap-1">
                Tokens <SortIcon col="tokens" />
              </span>
            </th>
            <th className={sortableThClass} onClick={() => handleSort('injections')}>
              <span className="inline-flex items-center justify-end gap-1">
                Injections <SortIcon col="injections" />
              </span>
            </th>
            <th className={sortableThClass} onClick={() => handleSort('avg_cost')}>
              <span className="inline-flex items-center justify-end gap-1">
                Avg $/Inj <SortIcon col="avg_cost" />
              </span>
            </th>
            <th className="text-right py-2 px-3 text-xs uppercase tracking-wider text-muted-foreground font-medium">
              Source
            </th>
          </tr>
        </thead>
        <tbody>
          {sortedData.map((p) => {
            const isEstimated = p.usage_source !== 'API';
            return (
              <tr
                key={p.pattern_id}
                className={cn(
                  'border-b border-border/50 transition-colors hover:bg-muted/50',
                  isEstimated && 'bg-yellow-500/[0.03]'
                )}
              >
                <td className="py-2 px-3">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{p.pattern_name}</span>
                    {isEstimated && (
                      <AlertTriangle className="w-3 h-3 text-yellow-500 flex-shrink-0" />
                    )}
                  </div>
                  <span className="text-[10px] text-muted-foreground font-mono">
                    {p.pattern_id}
                  </span>
                </td>
                <td className="py-2 px-3 text-right font-mono">${p.total_cost_usd.toFixed(2)}</td>
                <td className="py-2 px-3 text-right font-mono text-muted-foreground">
                  {(p.prompt_tokens + p.completion_tokens).toLocaleString()}
                </td>
                <td className="py-2 px-3 text-right font-mono">{p.injection_count}</td>
                <td className="py-2 px-3 text-right font-mono text-muted-foreground">
                  ${p.avg_cost_per_injection.toFixed(4)}
                </td>
                <td className="py-2 px-3 text-right">
                  <UsageSourceBadge source={p.usage_source} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ============================================================================
// 5. Token Usage Stacked Bar
// ============================================================================

/**
 * Stacked bar chart showing prompt vs completion token volume over time.
 * Prompt and completion tokens are rendered as a stacked bar pair per bucket.
 *
 * @param props - Component props.
 * @param props.data - Array of token-usage data points with prompt/completion splits.
 * @returns A Recharts stacked bar chart, or an empty-state placeholder when data is absent.
 */
function TokenUsageChart({ data }: { data: TokenUsagePoint[] | undefined }) {
  if (!data?.length) {
    return (
      <div className="h-[280px] flex items-center justify-center text-muted-foreground text-sm">
        No token usage data available
      </div>
    );
  }

  const chartData = data.map((p) => ({
    time: p.timestamp.length > 10 ? p.timestamp.slice(11, 16) : p.timestamp.slice(5),
    Prompt: p.prompt_tokens,
    Completion: p.completion_tokens,
  }));

  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
        <XAxis
          dataKey="time"
          tick={{ fill: 'hsl(var(--foreground))', fontSize: 11, fillOpacity: 0.85 }}
        />
        <YAxis
          tick={{ fill: 'hsl(var(--foreground))', fontSize: 11, fillOpacity: 0.85 }}
          tickFormatter={(v: number) => `${(v / 1000).toFixed(0)}k`}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: 'hsl(var(--card))',
            border: '1px solid hsl(var(--border))',
            borderRadius: '6px',
            fontSize: '12px',
          }}
          formatter={(value: any, name: any) => [value.toLocaleString(), name]}
        />
        <Legend wrapperStyle={{ fontSize: '12px' }} />
        <Bar dataKey="Prompt" stackId="a" fill="#3b82f6" radius={[0, 0, 0, 0]} />
        <Bar dataKey="Completion" stackId="a" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

// ============================================================================
// 6. Budget Threshold Alerts
// ============================================================================

/**
 * Grid of budget alert cards, each showing spend vs threshold with a
 * progress bar. Cards with triggered alerts get a red left border and badge.
 *
 * @param props - Component props.
 * @param props.data - Array of budget alert definitions with current spend and thresholds.
 * @returns A responsive grid of alert cards, or an empty-state message when none are configured.
 */
function BudgetAlertCards({ data }: { data: BudgetAlert[] | undefined }) {
  if (!data?.length) {
    return (
      <div className="py-6 text-center text-muted-foreground text-sm">
        No budget alerts configured
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      {data.map((alert) => {
        const pctCapped = Math.min(alert.utilization_pct, 100);
        const barColor = alert.is_triggered
          ? 'bg-red-500'
          : alert.utilization_pct > 80
            ? 'bg-yellow-500'
            : 'bg-green-500';

        return (
          <Card
            key={alert.id}
            className={cn(
              'border-l-4',
              alert.is_triggered ? 'border-l-red-500' : 'border-l-green-500'
            )}
          >
            <CardContent className="py-3 px-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium">{alert.name}</span>
                {alert.is_triggered && (
                  <Badge className="bg-red-500/20 text-red-400 border-red-500/30 text-[10px]">
                    TRIGGERED
                  </Badge>
                )}
              </div>
              <div className="flex items-baseline gap-1 mb-2">
                <span className="text-xl font-bold font-mono">
                  ${alert.current_spend_usd.toFixed(2)}
                </span>
                <span className="text-xs text-muted-foreground">
                  / ${alert.threshold_usd.toFixed(2)} {alert.period}
                </span>
              </div>
              {/* Progress bar */}
              <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                <div
                  className={cn('h-full rounded-full transition-all', barColor)}
                  style={{ width: `${pctCapped}%` }}
                />
              </div>
              <div className="text-[10px] text-muted-foreground mt-1 font-mono">
                {alert.utilization_pct.toFixed(1)}% utilized
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

/**
 * Cost Trend dashboard page.
 *
 * Renders six views (cost over time, by model, by repo, by pattern,
 * token usage, and budget alerts) with a time-window selector and
 * estimated-data toggle.  Data is fetched via TanStack Query with
 * 15-30s auto-refresh intervals and real-time WebSocket invalidation.
 *
 * @returns The full Cost Trends page layout including hero metric, summary cards,
 *   chart grid, budget alerts, and the cost-by-pattern table.
 */
export default function CostTrendDashboard() {
  const queryClient = useQueryClient();

  // ---------------------------------------------------------------------------
  // Local state
  // ---------------------------------------------------------------------------

  const [timeWindow, setTimeWindow] = useState<CostTimeWindow>('7d');
  const [includeEstimated, setIncludeEstimated] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // Data Fetching
  // ---------------------------------------------------------------------------

  const fetchOpts = { includeEstimated };

  const {
    data: summary,
    isLoading: summaryLoading,
    isError: summaryError,
  } = useQuery<CostSummary>({
    queryKey: [...queryKeys.costs.summary(timeWindow), includeEstimated],
    queryFn: () => costSource.summary(timeWindow, fetchOpts),
    refetchInterval: 15_000,
  });

  const trendFetchOpts = { includeEstimated, model: selectedModel ?? undefined };

  const {
    data: trend,
    isLoading: trendLoading,
    isError: trendError,
  } = useQuery<CostTrendPoint[]>({
    queryKey: [...queryKeys.costs.trend(timeWindow, selectedModel ?? undefined), includeEstimated],
    queryFn: () => costSource.trend(timeWindow, trendFetchOpts),
    refetchInterval: 15_000,
  });

  const {
    data: byModel,
    isLoading: modelLoading,
    isError: modelError,
  } = useQuery<CostByModel[]>({
    queryKey: [...queryKeys.costs.byModel(), includeEstimated],
    queryFn: () => costSource.byModel(fetchOpts),
    refetchInterval: 30_000,
  });

  const {
    data: byRepo,
    isLoading: repoLoading,
    isError: repoError,
  } = useQuery<CostByRepo[]>({
    queryKey: [...queryKeys.costs.byRepo(), includeEstimated],
    queryFn: () => costSource.byRepo(fetchOpts),
    refetchInterval: 30_000,
  });

  const {
    data: byPattern,
    isLoading: patternLoading,
    isError: patternError,
  } = useQuery<CostByPattern[]>({
    queryKey: [...queryKeys.costs.byPattern(), includeEstimated],
    queryFn: () => costSource.byPattern(fetchOpts),
    refetchInterval: 30_000,
  });

  const {
    data: tokenUsage,
    isLoading: tokenLoading,
    isError: tokenError,
  } = useQuery<TokenUsagePoint[]>({
    queryKey: [...queryKeys.costs.tokenUsage(timeWindow), includeEstimated],
    queryFn: () => costSource.tokenUsage(timeWindow, fetchOpts),
    refetchInterval: 15_000,
  });

  const {
    data: alerts,
    isLoading: alertsLoading,
    isError: alertsError,
  } = useQuery<BudgetAlert[]>({
    queryKey: queryKeys.costs.alerts(),
    queryFn: () => costSource.alerts(),
    refetchInterval: 30_000,
  });

  // ---------------------------------------------------------------------------
  // WebSocket
  // ---------------------------------------------------------------------------

  const { subscribe, unsubscribe, isConnected } = useWebSocket({
    onMessage: (msg) => {
      if (msg.type === 'COST_UPDATE') {
        queryClient.invalidateQueries({ queryKey: queryKeys.costs.all });
      }
    },
  });

  useEffect(() => {
    if (isConnected) {
      subscribe(['costs']);
    }
    return () => {
      unsubscribe(['costs']);
    };
  }, [isConnected, subscribe, unsubscribe]);

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleWindowChange = useCallback((w: CostTimeWindow) => {
    setTimeWindow(w);
  }, []);

  // ---------------------------------------------------------------------------
  // Derived values
  // ---------------------------------------------------------------------------

  const heroValue = summary ? `$${summary.total_cost_usd.toFixed(2)}` : '--';
  const heroSubtitle = summary
    ? `${summary.session_count} sessions | ${summary.model_count} models | ${summary.total_tokens.toLocaleString()} tokens`
    : 'Total LLM spend in selected window';
  const heroStatus: 'healthy' | 'warning' | 'error' | undefined = summary
    ? summary.active_alerts > 0
      ? 'error'
      : summary.cost_change_pct > 20
        ? 'error'
        : summary.cost_change_pct > 5
          ? 'warning'
          : 'healthy'
    : undefined;

  const triggeredAlerts = alerts?.filter((a) => a.is_triggered).length ?? 0;

  return (
    <div className="space-y-6" data-testid="page-cost-trends">
      {/* Demo mode banner */}
      <DemoBanner />

      {/* Page Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <DollarSign className="w-6 h-6 text-primary" />
            Cost Trends
          </h2>
          <p className="text-sm text-muted-foreground">
            LLM cost and token usage trends with drill-down by model, repo, and pattern
          </p>
        </div>
        <div className="flex items-center gap-4 flex-wrap">
          <EstimatedToggle
            checked={includeEstimated}
            onCheckedChange={setIncludeEstimated}
            coveragePct={summary?.reported_coverage_pct}
          />
          <WindowSelector value={timeWindow} onChange={handleWindowChange} />
          <div className="flex items-center gap-1.5">
            <div
              className={`h-2 w-2 rounded-full ${isConnected ? 'bg-green-500 animate-pulse' : 'bg-muted-foreground'}`}
            />
            <span className="text-[10px] text-muted-foreground">
              {isConnected ? 'Live' : 'Offline'}
            </span>
          </div>
        </div>
      </div>

      {/* Error Banner */}
      {summaryError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Failed to load cost data</AlertTitle>
          <AlertDescription>
            Cost summary could not be retrieved. Other charts may also be affected.
          </AlertDescription>
        </Alert>
      )}

      {/* Hero Metric: Total Cost */}
      <HeroMetric
        label={`Total Spend (${timeWindow})`}
        value={heroValue}
        subtitle={heroSubtitle}
        status={heroStatus}
        isLoading={summaryLoading}
      />

      {/* Supporting Metric Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <MetricCard
          label="Cost Change"
          value={
            summary
              ? `${summary.cost_change_pct > 0 ? '+' : ''}${summary.cost_change_pct.toFixed(1)}%`
              : '--'
          }
          subtitle="vs previous period"
          icon={
            summary?.cost_change_pct !== undefined && summary.cost_change_pct < 0
              ? TrendingDown
              : TrendingUp
          }
          status={
            summary
              ? summary.cost_change_pct < -5
                ? 'healthy'
                : summary.cost_change_pct > 20
                  ? 'error'
                  : 'warning'
              : undefined
          }
          isLoading={summaryLoading}
        />
        <MetricCard
          label="Avg Cost/Session"
          value={summary ? `$${summary.avg_cost_per_session.toFixed(4)}` : '--'}
          subtitle={summary ? `${summary.session_count} sessions` : undefined}
          icon={Coins}
          isLoading={summaryLoading}
        />
        <MetricCard
          label="Total Tokens"
          value={summary ? summary.total_tokens.toLocaleString() : '--'}
          subtitle={
            summary
              ? `${summary.prompt_tokens.toLocaleString()} prompt / ${summary.completion_tokens.toLocaleString()} completion`
              : undefined
          }
          icon={Cpu}
          isLoading={summaryLoading}
        />
        <MetricCard
          label="Budget Alerts"
          value={triggeredAlerts > 0 ? `${triggeredAlerts} triggered` : 'All clear'}
          subtitle={alerts ? `${alerts.length} alerts configured` : undefined}
          icon={Bell}
          status={triggeredAlerts > 0 ? 'error' : 'healthy'}
          isLoading={alertsLoading}
        />
      </div>

      {/* Charts Grid Row 1: Cost Trend + Token Usage */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-muted-foreground" />
                Cost Over Time ({timeWindow})
              </CardTitle>
              <ModelSelector
                value={selectedModel}
                onChange={setSelectedModel}
                className="w-[180px] h-8 text-xs"
              />
            </div>
          </CardHeader>
          <CardContent>
            {trendError ? (
              <p className="text-sm text-destructive py-8 text-center">
                Failed to load trend data.
              </p>
            ) : trendLoading ? (
              <Skeleton className="h-[280px] w-full rounded-lg" />
            ) : (
              <CostTrendChart data={trend} includeEstimated={includeEstimated} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-muted-foreground" />
              Token Usage ({timeWindow})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {tokenError ? (
              <p className="text-sm text-destructive py-8 text-center">
                Failed to load token usage data.
              </p>
            ) : tokenLoading ? (
              <Skeleton className="h-[280px] w-full rounded-lg" />
            ) : (
              <TokenUsageChart data={tokenUsage} />
            )}
          </CardContent>
        </Card>
      </div>

      {/* Charts Grid Row 2: By Model + By Repo */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Cpu className="w-4 h-4 text-muted-foreground" />
              Cost by Model
            </CardTitle>
          </CardHeader>
          <CardContent>
            {modelError ? (
              <p className="text-sm text-destructive py-8 text-center">
                Failed to load model data.
              </p>
            ) : modelLoading ? (
              <Skeleton className="h-[280px] w-full rounded-lg" />
            ) : (
              <CostByModelChart data={byModel} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <GitBranch className="w-4 h-4 text-muted-foreground" />
              Cost by Repo
            </CardTitle>
          </CardHeader>
          <CardContent>
            {repoError ? (
              <p className="text-sm text-destructive py-8 text-center">Failed to load repo data.</p>
            ) : repoLoading ? (
              <Skeleton className="h-[280px] w-full rounded-lg" />
            ) : (
              <CostByRepoChart data={byRepo} />
            )}
          </CardContent>
        </Card>
      </div>

      {/* Budget Alerts */}
      <div>
        <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <AlertTriangle className="w-5 h-5 text-muted-foreground" />
          Budget Alerts
          {triggeredAlerts > 0 && (
            <Badge className="bg-red-500/20 text-red-400 border-red-500/30 text-xs">
              {triggeredAlerts} triggered
            </Badge>
          )}
        </h3>
        {alertsError ? (
          <p className="text-sm text-destructive py-4 text-center">Failed to load budget alerts.</p>
        ) : alertsLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-[120px] w-full rounded-lg" />
            ))}
          </div>
        ) : (
          <BudgetAlertCards data={alerts} />
        )}
      </div>

      {/* Cost by Pattern Table */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <Layers className="w-4 h-4 text-muted-foreground" />
              Cost by Pattern
            </CardTitle>
            {byPattern && (
              <span className="text-xs text-muted-foreground">{byPattern.length} patterns</span>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {patternError ? (
            <p className="text-sm text-destructive py-8 text-center">
              Failed to load pattern data.
            </p>
          ) : patternLoading ? (
            <Skeleton className="h-[300px] w-full rounded-lg" />
          ) : (
            <CostByPatternTable data={byPattern} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
