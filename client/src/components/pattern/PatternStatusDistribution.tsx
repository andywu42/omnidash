/**
 * PatternStatusDistribution
 *
 * Donut chart showing pattern counts by lifecycle state.
 * Part of OMN-1798: Pattern Health Visualization Widget
 */

import { useMemo } from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertCircle, PieChart as PieChartIcon } from 'lucide-react';
import type { PatlearnSummary, LifecycleState } from '@/lib/schemas/api-response-schemas';

// ===========================
// Types
// ===========================

interface PatternStatusDistributionProps {
  summary: PatlearnSummary | null | undefined;
  isLoading?: boolean;
  isError?: boolean;
  onStateClick?: (state: LifecycleState | null) => void;
  selectedState?: LifecycleState | null;
}

interface ChartDataItem {
  name: string;
  value: number;
  state: LifecycleState;
  color: string;
  hoverColor: string;
}

// ===========================
// Constants
// ===========================

/**
 * Color mapping matching LifecycleStateBadge colors
 * Uses CSS-compatible colors for recharts
 */
const STATE_COLORS: Record<LifecycleState, { fill: string; hover: string; label: string }> = {
  requested: {
    fill: '#94a3b8', // slate-400
    hover: '#64748b', // slate-500
    label: 'Requested',
  },
  candidate: {
    fill: '#eab308', // yellow-500
    hover: '#ca8a04', // yellow-600
    label: 'Candidate',
  },
  provisional: {
    fill: '#3b82f6', // blue-500
    hover: '#2563eb', // blue-600
    label: 'Provisional',
  },
  validated: {
    fill: '#16a34a', // green-600
    hover: '#15803d', // green-700
    label: 'Validated',
  },
  deprecated: {
    fill: '#6b7280', // gray-500
    hover: '#4b5563', // gray-600
    label: 'Deprecated',
  },
};

const LIFECYCLE_ORDER: LifecycleState[] = ['requested', 'candidate', 'provisional', 'validated', 'deprecated'];

// ===========================
// Custom Tooltip
// ===========================

interface TooltipPayload {
  name?: string;
  value?: number;
  payload: ChartDataItem;
}

function CustomTooltip({
  active,
  payload,
  total,
}: {
  active?: boolean;
  payload?: TooltipPayload[];
  total?: number;
}) {
  if (!active || !payload?.[0] || total === undefined) return null;

  const data = payload[0].payload;
  const percentage = total > 0 ? ((data.value / total) * 100).toFixed(1) : '0';

  return (
    <div className="rounded-lg border bg-background px-3 py-2 shadow-lg">
      <p className="font-medium text-sm">{data.name}</p>
      <p className="text-muted-foreground text-sm">
        {data.value.toLocaleString()} patterns ({percentage}%)
      </p>
    </div>
  );
}

// ===========================
// Custom Legend
// ===========================

interface LegendPayload {
  value: string;
  color: string;
  payload?: {
    state: LifecycleState;
    value: number;
  };
}

function CustomLegend({
  payload,
  selectedState,
  onStateClick,
}: {
  payload?: LegendPayload[];
  selectedState?: LifecycleState | null;
  onStateClick?: (state: LifecycleState | null) => void;
}) {
  if (!payload) return null;

  return (
    <div className="flex flex-wrap justify-center gap-3 mt-4">
      {payload.map((entry) => {
        const state = entry.payload?.state;
        const isSelected = selectedState === state;
        const isFiltered = selectedState && selectedState !== state;

        return (
          <button
            key={entry.value}
            type="button"
            onClick={() => onStateClick?.(isSelected ? null : state || null)}
            className={`
              flex items-center gap-2 px-2 py-1 rounded text-sm transition-all
              ${onStateClick ? 'cursor-pointer hover:bg-muted' : 'cursor-default'}
              ${isFiltered ? 'opacity-40' : 'opacity-100'}
              ${isSelected ? 'ring-2 ring-primary ring-offset-2' : ''}
            `}
          >
            <span className="w-3 h-3 rounded-full" style={{ backgroundColor: entry.color }} />
            <span className="text-foreground">{entry.value}</span>
            <span className="text-muted-foreground font-mono">
              {entry.payload?.value?.toLocaleString() ?? 0}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ===========================
// Main Component
// ===========================

export function PatternStatusDistribution({
  summary,
  isLoading = false,
  isError = false,
  onStateClick,
  selectedState,
}: PatternStatusDistributionProps) {
  // Transform summary data into chart format
  const chartData = useMemo((): ChartDataItem[] => {
    if (!summary?.byState) return [];

    return LIFECYCLE_ORDER.map((state) => ({
      name: STATE_COLORS[state].label,
      value: summary.byState[state] ?? 0,
      state,
      color: STATE_COLORS[state].fill,
      hoverColor: STATE_COLORS[state].hover,
    })).filter((item) => item.value > 0); // Only show states with patterns
  }, [summary]);

  const totalPatterns = useMemo(
    () => chartData.reduce((sum, item) => sum + item.value, 0),
    [chartData]
  );

  // Loading state
  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <PieChartIcon className="h-4 w-4" />
            Status Distribution
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center h-[280px]">
            <Skeleton className="w-48 h-48 rounded-full" />
          </div>
          <div className="flex justify-center gap-4 mt-4">
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-6 w-20" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  // Error state
  if (isError) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <PieChartIcon className="h-4 w-4" />
            Status Distribution
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center h-[280px] text-center">
            <AlertCircle className="h-8 w-8 text-destructive mb-2" />
            <p className="text-sm text-muted-foreground">Failed to load data</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Empty state
  if (chartData.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <PieChartIcon className="h-4 w-4" />
            Status Distribution
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center h-[280px] text-center">
            <PieChartIcon className="h-8 w-8 text-muted-foreground mb-2 opacity-50" />
            <p className="text-sm text-muted-foreground">No patterns available</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <PieChartIcon className="h-4 w-4" />
          Status Distribution
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={280}>
          <PieChart>
            <Pie
              data={chartData}
              cx="50%"
              cy="50%"
              innerRadius={60}
              outerRadius={100}
              paddingAngle={2}
              dataKey="value"
              onClick={(data) => {
                if (onStateClick && data?.state) {
                  const clickedState = data.state as LifecycleState;
                  onStateClick(selectedState === clickedState ? null : clickedState);
                }
              }}
              style={{ cursor: onStateClick ? 'pointer' : 'default' }}
            >
              {chartData.map((entry) => (
                <Cell
                  key={entry.state}
                  fill={entry.color}
                  stroke="hsl(var(--background))"
                  strokeWidth={2}
                  opacity={selectedState && selectedState !== entry.state ? 0.4 : 1}
                />
              ))}
            </Pie>
            <Tooltip
              content={({ active, payload }) => (
                <CustomTooltip
                  active={active}
                  payload={payload as TooltipPayload[] | undefined}
                  total={totalPatterns}
                />
              )}
            />
            {/* Center label showing total */}
            <text
              x="50%"
              y="47%"
              textAnchor="middle"
              dominantBaseline="middle"
              className="fill-foreground text-2xl font-bold"
            >
              {totalPatterns.toLocaleString()}
            </text>
            <text
              x="50%"
              y="55%"
              textAnchor="middle"
              dominantBaseline="middle"
              className="fill-muted-foreground text-xs"
            >
              patterns
            </text>
          </PieChart>
        </ResponsiveContainer>
        <CustomLegend
          payload={chartData.map((item) => ({
            value: item.name,
            color: item.color,
            payload: { state: item.state, value: item.value },
          }))}
          selectedState={selectedState}
          onStateClick={onStateClick}
        />
      </CardContent>
    </Card>
  );
}
