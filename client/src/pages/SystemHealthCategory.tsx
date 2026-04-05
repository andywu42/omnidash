/**
 * System Health & Learning Category Dashboard (OMN-2181)
 *
 * Phase 2 consolidated view combining Node Registry and
 * Validation Dashboard into a single category landing page.
 *
 * Hero Metric: Pattern Validation count (confirmed / total)
 * Content: Node registry status, validation lifecycle, health checks
 * Sources: NodeRegistry, ValidationDashboard
 */

import { useQuery } from '@tanstack/react-query';
import { useProjectionStream } from '@/hooks/useProjectionStream';
import { validationSource } from '@/lib/data-sources/validation-source';
import type { ValidationSummary } from '@/lib/data-sources/validation-source';
import type { NodeRegistryPayload } from '@/lib/data-sources/node-registry-projection-source';
import { queryKeys } from '@/lib/query-keys';
import { MetricCard } from '@/components/MetricCard';
import { HeroMetric } from '@/components/HeroMetric';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Link } from 'wouter';
import {
  ShieldCheck,
  Globe,
  ArrowRight,
  CheckCircle,
  AlertTriangle,
  Server,
  Layers,
  AlertCircle,
} from 'lucide-react';
import { DataSourceHealthPanel } from '@/components/DataSourceHealthPanel';
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Legend,
} from 'recharts';

// ============================================================================
// Violation Severity Chart
// ============================================================================

const SEVERITY_COLORS: Record<string, string> = {
  critical: '#ef4444',
  error: '#f97316',
  warning: '#f59e0b',
  info: '#3b82f6',
};

function ViolationSeverityChart({
  data,
  isLoading,
}: {
  data: ValidationSummary | undefined;
  isLoading: boolean;
}) {
  if (isLoading) {
    return <Skeleton className="h-[200px] w-full rounded-lg" />;
  }

  if (!data?.total_violations_by_severity) {
    return (
      <div className="h-[200px] flex items-center justify-center text-muted-foreground text-sm">
        No violation data available
      </div>
    );
  }

  const chartData = Object.entries(data.total_violations_by_severity)
    .filter(([, count]) => count > 0)
    .map(([severity, count]) => ({
      name: severity.charAt(0).toUpperCase() + severity.slice(1),
      value: count,
      fill: SEVERITY_COLORS[severity] ?? '#6b7280',
    }));

  if (chartData.length === 0) {
    return (
      <div className="h-[200px] flex items-center justify-center text-muted-foreground text-sm">
        No violations found -- all clear
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={200}>
      <PieChart>
        <Pie
          data={chartData}
          cx="50%"
          cy="50%"
          innerRadius={45}
          outerRadius={75}
          paddingAngle={3}
          dataKey="value"
          label={({ name, percent }) => `${name} ${((percent ?? 0) * 100).toFixed(0)}%`}
        >
          {chartData.map((entry, index) => (
            <Cell key={`cell-${index}`} fill={entry.fill} />
          ))}
        </Pie>
        <Tooltip
          contentStyle={{
            backgroundColor: 'hsl(var(--card))',
            border: '1px solid hsl(var(--border))',
            borderRadius: '6px',
            fontSize: '12px',
          }}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}

// ============================================================================
// Node Status Overview Chart
// ============================================================================

function NodeStatusChart({
  data,
  isLoading,
}: {
  data: NodeRegistryPayload | null;
  isLoading: boolean;
}) {
  if (isLoading) {
    return <Skeleton className="h-[200px] w-full rounded-lg" />;
  }

  if (!data || data.nodes.length === 0) {
    return (
      <div className="h-[200px] flex items-center justify-center text-muted-foreground text-sm">
        No registered nodes available
      </div>
    );
  }

  // Aggregate by node type
  const typeDistribution = data.nodes.reduce(
    (acc, node) => {
      const type = node.nodeType;
      if (!acc[type]) acc[type] = { active: 0, pending: 0, failed: 0 };
      if (node.state === 'active') {
        acc[type].active += 1;
      } else if (['rejected', 'liveness_expired', 'ack_timed_out'].includes(node.state)) {
        acc[type].failed += 1;
      } else {
        acc[type].pending += 1;
      }
      return acc;
    },
    {} as Record<string, { active: number; pending: number; failed: number }>
  );

  const chartData = Object.entries(typeDistribution).map(([type, counts]) => ({
    type: type.charAt(0).toUpperCase() + type.slice(1),
    Active: counts.active,
    Pending: counts.pending,
    Failed: counts.failed,
  }));

  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
        <XAxis
          dataKey="type"
          tick={{ fill: 'hsl(var(--foreground))', fontSize: 11, fillOpacity: 0.85 }}
        />
        <YAxis
          tick={{ fill: 'hsl(var(--foreground))', fontSize: 11, fillOpacity: 0.85 }}
          allowDecimals={false}
        />
        <Tooltip
          cursor={{ fill: 'hsl(var(--muted))' }}
          contentStyle={{
            backgroundColor: 'hsl(var(--card))',
            border: '1px solid hsl(var(--border))',
            borderRadius: '6px',
            fontSize: '12px',
          }}
        />
        <Legend wrapperStyle={{ fontSize: '12px' }} />
        <Bar dataKey="Active" fill="#22c55e" radius={[2, 2, 0, 0]} />
        <Bar dataKey="Pending" fill="#f59e0b" radius={[2, 2, 0, 0]} />
        <Bar dataKey="Failed" fill="#ef4444" radius={[2, 2, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export default function SystemHealthCategory() {
  // ---------------------------------------------------------------------------
  // Node Registry Projection
  // ---------------------------------------------------------------------------
  const {
    data: nodeSnapshot,
    isLoading: nodeLoading,
    isConnected,
  } = useProjectionStream<NodeRegistryPayload>('node-registry-db');

  const nodeData = nodeSnapshot?.payload ?? null;

  // ---------------------------------------------------------------------------
  // Validation Summary
  // ---------------------------------------------------------------------------
  const {
    data: validationSummary,
    isLoading: validationLoading,
    isError: validationError,
  } = useQuery<ValidationSummary>({
    queryKey: queryKeys.validation.summary(),
    queryFn: () => validationSource.summary(),
    refetchInterval: 30_000,
  });

  // ---------------------------------------------------------------------------
  // Derived values
  // ---------------------------------------------------------------------------

  // Node stats
  const totalNodes = nodeData?.nodes.length ?? 0;
  const activeNodes = nodeData?.nodes.filter((n) => n.state === 'active').length ?? 0;
  const failedNodes =
    nodeData?.nodes.filter((n) =>
      ['rejected', 'liveness_expired', 'ack_timed_out'].includes(n.state)
    ).length ?? 0;

  // Validation stats
  const totalRuns = validationSummary?.total_runs ?? 0;
  const passRate = validationSummary?.pass_rate ?? 0;
  const completedRuns = validationSummary?.completed_runs ?? 0;

  // Hero metric: Validation pass count
  const passedRuns = Math.round(completedRuns * passRate);
  const heroValue = `${passedRuns} / ${completedRuns}`;
  const heroStatus: 'healthy' | 'warning' | 'error' | undefined =
    completedRuns > 0
      ? passRate >= 0.9
        ? 'healthy'
        : passRate >= 0.7
          ? 'warning'
          : 'error'
      : undefined;

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <ShieldCheck className="w-6 h-6 text-primary" />
            System Health & Learning
          </h2>
          <p className="text-sm text-muted-foreground">
            Node registry status, validation lifecycle, and health checks
          </p>
        </div>
        <div className="flex items-center gap-2">
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
      {validationError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Failed to load validation data</AlertTitle>
          <AlertDescription>
            Validation summary could not be retrieved. Validation metrics may be unavailable.
          </AlertDescription>
        </Alert>
      )}

      {/* Hero Metric: Validation Pass Count */}
      <HeroMetric
        label="Pattern Validation (Confirmed / Total)"
        value={heroValue}
        subtitle={`${(passRate * 100).toFixed(1)}% pass rate across ${totalRuns} total runs`}
        status={heroStatus}
        isLoading={validationLoading}
      />

      {/* Supporting Metric Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <MetricCard
          label="Active Nodes"
          value={activeNodes}
          subtitle={`${totalNodes} total registered`}
          icon={Server}
          status={
            totalNodes > 0
              ? failedNodes === 0
                ? 'healthy'
                : failedNodes <= 2
                  ? 'warning'
                  : 'error'
              : undefined
          }
          isLoading={nodeLoading}
        />
        <MetricCard
          label="Failed Nodes"
          value={failedNodes}
          subtitle="Rejected, expired, or timed out"
          icon={AlertTriangle}
          status={
            totalNodes > 0
              ? failedNodes === 0
                ? 'healthy'
                : failedNodes <= 2
                  ? 'warning'
                  : 'error'
              : undefined
          }
          isLoading={nodeLoading}
        />
        <MetricCard
          label="Validation Pass Rate"
          value={`${(passRate * 100).toFixed(1)}%`}
          subtitle={`${completedRuns} completed runs`}
          icon={CheckCircle}
          status={
            completedRuns > 0
              ? passRate >= 0.9
                ? 'healthy'
                : passRate >= 0.7
                  ? 'warning'
                  : 'error'
              : undefined
          }
          isLoading={validationLoading}
        />
        <MetricCard
          label="Unique Repos"
          value={validationSummary?.unique_repos ?? 0}
          subtitle="Repositories under validation"
          icon={Layers}
          isLoading={validationLoading}
        />
      </div>

      {/* Charts Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Server className="w-4 h-4 text-muted-foreground" />
              Node Status by Type
            </CardTitle>
          </CardHeader>
          <CardContent>
            <NodeStatusChart data={nodeData} isLoading={nodeLoading} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-muted-foreground" />
              Violations by Severity
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ViolationSeverityChart data={validationSummary} isLoading={validationLoading} />
          </CardContent>
        </Card>
      </div>

      {/* Data Source Health Audit (OMN-2307) */}
      <DataSourceHealthPanel />

      {/* Drill-Down Navigation */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Link href="/registry">
          <Card className="cursor-pointer hover:bg-muted/50 transition-colors group">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Globe className="w-4 h-4 text-muted-foreground" />
                Node Registry
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Full node registration events, heartbeats, and state transitions.
              </p>
              <div className="flex items-center gap-1 mt-3 text-xs text-primary group-hover:underline">
                View details
                <ArrowRight className="w-3 h-3" />
              </div>
            </CardContent>
          </Card>
        </Link>
        <Link href="/validation">
          <Card className="cursor-pointer hover:bg-muted/50 transition-colors group">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-muted-foreground" />
                Validation Dashboard
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Cross-repo validation run history, violation details, and trend analysis.
              </p>
              <div className="flex items-center gap-1 mt-3 text-xs text-primary group-hover:underline">
                View details
                <ArrowRight className="w-3 h-3" />
              </div>
            </CardContent>
          </Card>
        </Link>
      </div>
    </div>
  );
}
