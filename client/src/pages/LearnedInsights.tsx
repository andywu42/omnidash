/**
 * LearnedInsights
 *
 * Dashboard panel displaying learned insights from OmniClaude sessions.
 * Shows patterns, conventions, architecture decisions, error resolutions,
 * and tool usage insights with confidence scores, evidence counts, and
 * expandable details.
 *
 * Demonstrates that "the system learns and gets smarter over time."
 *
 * @see OMN-1407 - Learned Insights Panel (OmniClaude Integration)
 */

import { useState, useCallback, useMemo, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { insightsSource } from '@/lib/data-sources/insights-source';
import { useWebSocket } from '@/hooks/useWebSocket';
import { DemoBanner } from '@/components/DemoBanner';
import { MetricCard } from '@/components/MetricCard';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';
import type {
  InsightsSummary,
  InsightsTrendPoint,
  Insight,
  InsightType,
} from '@shared/insights-types';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import type { LegendPayload } from 'recharts/types/component/DefaultLegendContent';
import {
  Brain,
  ChevronDown,
  ChevronUp,
  FileCode,
  ScrollText,
  Building2,
  AlertCircle,
  AlertTriangle,
  Wrench,
  TrendingUp,
  RefreshCw,
  Lightbulb,
  GraduationCap,
  CheckCircle,
  XCircle,
  Minus,
} from 'lucide-react';

// ============================================================================
// Constants
// ============================================================================

const INSIGHT_ICONS: Record<InsightType, typeof FileCode> = {
  pattern: FileCode,
  convention: ScrollText,
  architecture: Building2,
  error: AlertCircle,
  tool: Wrench,
};

const INSIGHT_LABELS: Record<InsightType, string> = {
  pattern: 'Pattern',
  convention: 'Convention',
  architecture: 'Architecture',
  error: 'Error',
  tool: 'Tool',
};

const INSIGHT_COLORS: Record<InsightType, string> = {
  pattern: 'text-blue-400',
  convention: 'text-emerald-400',
  architecture: 'text-purple-400',
  error: 'text-orange-400',
  tool: 'text-cyan-400',
};

const INSIGHT_BG: Record<InsightType, string> = {
  pattern: 'bg-blue-400/10 border-blue-400/20',
  convention: 'bg-emerald-400/10 border-emerald-400/20',
  architecture: 'bg-purple-400/10 border-purple-400/20',
  error: 'bg-orange-400/10 border-orange-400/20',
  tool: 'bg-cyan-400/10 border-cyan-400/20',
};

type FilterType = 'all' | InsightType;

// ============================================================================
// Sub-Components
// ============================================================================

function ConfidenceBar({ confidence }: { confidence: number }) {
  const pct = Math.round(confidence * 100);
  return (
    <div className="flex items-center gap-2">
      <div
        className="w-16 h-1.5 rounded-full bg-muted overflow-hidden"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Confidence: ${pct}%`}
      >
        <div
          className={cn(
            'h-full rounded-full transition-all',
            pct >= 90
              ? 'bg-emerald-500'
              : pct >= 75
                ? 'bg-blue-500'
                : pct >= 60
                  ? 'bg-yellow-500'
                  : 'bg-orange-500'
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs font-mono text-muted-foreground">{pct}%</span>
    </div>
  );
}

function InsightCard({
  insight,
  isExpanded,
  onToggle,
}: {
  insight: Insight;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const Icon = INSIGHT_ICONS[insight.type];
  const color = INSIGHT_COLORS[insight.type];
  const bg = INSIGHT_BG[insight.type];

  const learnedAgo = formatTimeAgo(insight.learned_at);
  const updatedAgo = formatTimeAgo(insight.updated_at);

  return (
    <Card
      className={cn(
        'transition-all cursor-pointer hover:ring-1 hover:ring-primary/20',
        isExpanded && 'ring-1 ring-primary/30'
      )}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle();
        }
      }}
      tabIndex={0}
      role="button"
      aria-expanded={isExpanded}
    >
      <CardContent className="py-3 px-4">
        <div className="flex items-start gap-3">
          {/* Type icon */}
          <div className={cn('p-1.5 rounded-md border flex-shrink-0 mt-0.5', bg)}>
            <Icon className={cn('w-4 h-4', color)} />
          </div>

          {/* Main content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="outline" className={cn('text-[10px] px-1.5 py-0', color)}>
                {INSIGHT_LABELS[insight.type].toUpperCase()}
              </Badge>
              <span className="text-sm font-medium">{insight.title}</span>
              {insight.trending && (
                <TrendingUp className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
              )}
              {insight.approved === true && (
                <CheckCircle className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />
              )}
              {insight.approved === false && (
                <XCircle className="w-3.5 h-3.5 text-red-500 flex-shrink-0" />
              )}
              {insight.approved === null && (
                <Minus className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
              )}
            </div>

            <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
              {insight.description}
            </p>

            <div className="flex items-center gap-4 mt-2 flex-wrap">
              <ConfidenceBar confidence={insight.confidence} />
              <span className="text-xs text-muted-foreground">
                Evidence: <span className="font-mono">{insight.evidence_count}</span> sessions
              </span>
              <span className="text-xs text-muted-foreground">Learned: {learnedAgo}</span>
              {updatedAgo !== learnedAgo && (
                <span className="text-xs text-muted-foreground">Updated: {updatedAgo}</span>
              )}
            </div>

            {/* Expandable details */}
            {isExpanded && insight.details && (
              <div className="mt-3 pt-3 border-t border-border">
                <p className="text-sm text-muted-foreground leading-relaxed">{insight.details}</p>
              </div>
            )}
          </div>

          {/* Expand toggle */}
          <div className="flex-shrink-0 mt-1">
            {isExpanded ? (
              <ChevronUp className="w-4 h-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="w-4 h-4 text-muted-foreground" />
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Helpers
// ============================================================================

function formatTimeAgo(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const hours = Math.floor(diff / 3600000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '1 day ago';
  if (days < 7) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (weeks === 1) return '1 week ago';
  return `${weeks} weeks ago`;
}

// ============================================================================
// Main Component
// ============================================================================

export default function LearnedInsights() {
  // ---------------------------------------------------------------------------
  // UI state
  // ---------------------------------------------------------------------------
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<FilterType>('all');
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(new Set());

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------
  const {
    data: summary,
    isLoading: summaryLoading,
    isError: summaryError,
    refetch: refetchSummary,
    isFetching: summaryFetching,
  } = useQuery<InsightsSummary>({
    queryKey: queryKeys.insights.summary(),
    queryFn: () => insightsSource.summary(),
    refetchInterval: 30_000,
  });

  const {
    data: trend,
    isLoading: trendLoading,
    isError: trendError,
  } = useQuery<InsightsTrendPoint[]>({
    queryKey: queryKeys.insights.trend(),
    queryFn: () => insightsSource.trend(),
    refetchInterval: 30_000,
  });

  // ---------------------------------------------------------------------------
  // WebSocket invalidation -- real-time updates when new insights are learned
  // ---------------------------------------------------------------------------
  const queryClient = useQueryClient();
  const { subscribe, unsubscribe, isConnected } = useWebSocket({
    onMessage: (msg) => {
      if (msg.type === 'INSIGHTS_UPDATE') {
        queryClient.invalidateQueries({ queryKey: queryKeys.insights.all });
      }
    },
  });

  useEffect(() => {
    if (isConnected) {
      subscribe(['insights']);
    }
    return () => {
      unsubscribe(['insights']);
    };
  }, [isConnected, subscribe, unsubscribe]);

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------
  const handleToggle = useCallback(
    (id: string) => setExpandedId((prev) => (prev === id ? null : id)),
    []
  );

  const handleRefresh = () => refetchSummary();

  const handleLegendClick = useCallback((entry: LegendPayload) => {
    const key = entry.dataKey != null ? String(entry.dataKey) : null;
    if (!key) return;
    setHiddenSeries((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  // ---------------------------------------------------------------------------
  // Filtered insights
  // ---------------------------------------------------------------------------
  const filteredInsights = useMemo(() => {
    if (!summary?.insights) return [];
    if (typeFilter === 'all') return summary.insights;
    return summary.insights.filter((i) => i.type === typeFilter);
  }, [summary?.insights, typeFilter]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className="space-y-6">
      {/* Demo mode banner */}
      <DemoBanner />

      {/* Error Banner */}
      {summaryError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Failed to load insights data</AlertTitle>
          <AlertDescription>
            Insights summary could not be retrieved. Trend data may also be affected.
          </AlertDescription>
        </Alert>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Brain className="w-6 h-6 text-primary" />
            Learned Insights
          </h2>
          <p className="text-sm text-muted-foreground">
            Patterns and conventions discovered from OmniClaude sessions
          </p>
        </div>
        <div className="flex items-center gap-3">
          {false && (
            <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30">
              Demo Data
            </Badge>
          )}
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={summaryFetching}>
            <RefreshCw className={cn('w-4 h-4 mr-1', summaryFetching && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Metric Tiles */}
      {summaryLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[88px] w-full rounded-lg" />
          ))}
        </div>
      ) : summary ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          <MetricCard
            label="Total Insights"
            value={summary.total}
            icon={Lightbulb}
            status="healthy"
            tooltip="Total learned insights across all types"
            subtitle={`+${summary.new_this_week} this week`}
          />
          <MetricCard
            label="Avg Confidence"
            value={`${(summary.avg_confidence * 100).toFixed(1)}%`}
            icon={GraduationCap}
            status={summary.avg_confidence >= 0.85 ? 'healthy' : 'warning'}
            tooltip="Average confidence score across all insights"
            subtitle="Higher is better"
          />
          <MetricCard
            label="Sessions Analyzed"
            value={summary.total_sessions_analyzed}
            icon={Brain}
            tooltip="Total OmniClaude sessions contributing evidence"
            subtitle="Contributing to insight discovery"
          />
          <MetricCard
            label="New This Week"
            value={`+${summary.new_this_week}`}
            icon={TrendingUp}
            status={summary.new_this_week > 0 ? 'healthy' : 'offline'}
            tooltip="New insights discovered in the last 7 days"
            subtitle="Active learning indicator"
          />
        </div>
      ) : null}

      {/* Discovery Trend Chart */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-muted-foreground" />
            Insight Discovery Trend
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            New insights and cumulative growth over the last 14 days
          </p>
        </CardHeader>
        <CardContent>
          {trendError ? (
            <Alert variant="destructive" className="mx-0">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Failed to load trend data</AlertTitle>
              <AlertDescription>Insight discovery trend could not be retrieved.</AlertDescription>
            </Alert>
          ) : trendLoading ? (
            <Skeleton className="h-[200px] w-full rounded-lg" />
          ) : trend && trend.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={trend} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
                <XAxis
                  dataKey="date"
                  tick={{ fill: 'hsl(var(--foreground))', fontSize: 11, fillOpacity: 0.85 }}
                  tickFormatter={(v: string) => v.slice(5)}
                />
                <YAxis tick={{ fill: 'hsl(var(--foreground))', fontSize: 11, fillOpacity: 0.85 }} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'hsl(var(--card))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '6px',
                    fontSize: '12px',
                  }}
                  labelStyle={{ color: 'hsl(var(--foreground))' }}
                />
                <Legend
                  onClick={handleLegendClick}
                  wrapperStyle={{ cursor: 'pointer', fontSize: '12px' }}
                  formatter={(value: string) => {
                    const labels: Record<string, string> = {
                      cumulative_insights: 'Cumulative',
                      new_insights: 'New',
                    };
                    return (
                      <span style={{ opacity: hiddenSeries.has(value) ? 0.35 : 1 }}>
                        {labels[value] ?? value}
                      </span>
                    );
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="cumulative_insights"
                  name="Cumulative"
                  stroke="#3b82f6"
                  fill="#3b82f6"
                  fillOpacity={0.1}
                  strokeWidth={2}
                  hide={hiddenSeries.has('cumulative_insights')}
                />
                <Area
                  type="monotone"
                  dataKey="new_insights"
                  name="New"
                  stroke="#22c55e"
                  fill="#22c55e"
                  fillOpacity={0.15}
                  strokeWidth={2}
                  hide={hiddenSeries.has('new_insights')}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[200px] flex items-center justify-center text-muted-foreground text-sm">
              No trend data available
            </div>
          )}
        </CardContent>
      </Card>

      {/* Type Distribution + Type Filter */}
      <div className="flex flex-col md:flex-row md:items-center gap-4">
        {/* Type distribution badges */}
        {summary && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-muted-foreground mr-1">By type:</span>
            {(Object.keys(INSIGHT_LABELS) as InsightType[]).map((type) => {
              const count = summary.by_type[type] ?? 0;
              if (count === 0) return null;
              const Icon = INSIGHT_ICONS[type];
              return (
                <Badge key={type} variant="outline" className="gap-1 text-xs">
                  <Icon className={cn('w-3 h-3', INSIGHT_COLORS[type])} />
                  {INSIGHT_LABELS[type]}: {count}
                </Badge>
              );
            })}
          </div>
        )}

        {/* Filter buttons */}
        <div className="flex items-center rounded-md border border-input ml-auto">
          <button
            onClick={() => setTypeFilter('all')}
            className={cn(
              'px-3 py-1 text-xs font-medium transition-colors rounded-l-md',
              typeFilter === 'all'
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            All
          </button>
          {(Object.keys(INSIGHT_LABELS) as InsightType[]).map((type, idx, arr) => (
            <button
              key={type}
              onClick={() => setTypeFilter(type)}
              className={cn(
                'px-3 py-1 text-xs font-medium transition-colors',
                idx === arr.length - 1 && 'rounded-r-md',
                typeFilter === type
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {INSIGHT_LABELS[type]}
            </button>
          ))}
        </div>
      </div>

      {/* Insight Cards List */}
      {summaryLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[100px] w-full rounded-lg" />
          ))}
        </div>
      ) : filteredInsights.length > 0 ? (
        <div className="space-y-3">
          {filteredInsights.map((insight) => (
            <InsightCard
              key={insight.id}
              insight={insight}
              isExpanded={expandedId === insight.id}
              onToggle={() => handleToggle(insight.id)}
            />
          ))}
        </div>
      ) : (
        <Card>
          <CardContent className="py-12 flex flex-col items-center justify-center text-muted-foreground">
            <Lightbulb className="w-10 h-10 mb-3 opacity-40" />
            <p className="text-sm">
              {typeFilter === 'all'
                ? 'No insights discovered yet'
                : `No ${INSIGHT_LABELS[typeFilter as InsightType].toLowerCase()} insights found`}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Footer summary */}
      {summary && filteredInsights.length > 0 && (
        <div className="text-xs text-muted-foreground text-center">
          Showing {filteredInsights.length} of {summary.total} insights · {summary.new_this_week}{' '}
          new this week
        </div>
      )}
    </div>
  );
}
