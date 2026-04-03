/**
 * Pipeline Overview Dashboard (OMN-6753)
 *
 * High-level pipeline status overview. Aggregates signals from existing
 * pipeline-health, pipeline-budget, and epic-pipeline dashboards into
 * a single landing page with summary stats and links to sub-dashboards.
 *
 * Data source: /api/pipeline-overview
 */

import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ArrowRight, GitBranch, DollarSign, HeartPulse } from 'lucide-react';

interface PipelineOverview {
  pipelineHealth: { total: number; stuck: number; active: number };
  epicRun: { totalRuns: number; activeRuns: number };
  budget: { totalBudgets: number; overBudget: number };
}

const PIPELINE_PAGES = [
  {
    title: 'Pipeline Health',
    url: '/pipeline-health',
    icon: HeartPulse,
    description: 'Per-ticket pipeline state, stuck detection, and CDQA gate results',
    statKey: 'pipelineHealth' as const,
  },
  {
    title: 'Epic Pipeline',
    url: '/epic-pipeline',
    icon: GitBranch,
    description: 'Epic-team pipeline run status and ticket progress',
    statKey: 'epicRun' as const,
  },
  {
    title: 'Pipeline Budget',
    url: '/pipeline-budget',
    icon: DollarSign,
    description: 'Token and cost budget caps per pipeline run',
    statKey: 'budget' as const,
  },
];

function StatBadge({
  label,
  value,
  variant,
}: {
  label: string;
  value: number;
  variant?: 'destructive' | 'secondary' | 'outline';
}) {
  return (
    <Badge variant={variant || 'secondary'} className="text-xs">
      {label}: {value}
    </Badge>
  );
}

export default function PipelineDashboard() {
  const { data, isLoading } = useQuery<PipelineOverview>({
    queryKey: ['pipeline-overview'],
    queryFn: async () => {
      const res = await fetch('/api/pipeline-overview');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 30_000,
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Pipeline</h1>
        <p className="text-muted-foreground mt-1">Unified pipeline health and status overview</p>
      </div>

      {/* Summary stats row */}
      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      ) : data ? (
        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Pipelines Tracked</p>
                  <p className="text-2xl font-bold">{data.pipelineHealth.total}</p>
                </div>
                <div className="flex flex-col gap-1">
                  <StatBadge label="Active" value={data.pipelineHealth.active} />
                  {data.pipelineHealth.stuck > 0 && (
                    <StatBadge
                      label="Stuck"
                      value={data.pipelineHealth.stuck}
                      variant="destructive"
                    />
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Epic Runs</p>
                  <p className="text-2xl font-bold">{data.epicRun.totalRuns}</p>
                </div>
                <StatBadge label="Running" value={data.epicRun.activeRuns} />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Budget Caps</p>
                  <p className="text-2xl font-bold">{data.budget.totalBudgets}</p>
                </div>
                {data.budget.overBudget > 0 ? (
                  <StatBadge
                    label="Over Budget"
                    value={data.budget.overBudget}
                    variant="destructive"
                  />
                ) : (
                  <StatBadge label="All OK" value={0} variant="outline" />
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      ) : null}

      {/* Links to existing pipeline sub-dashboards */}
      <div className="grid gap-4 md:grid-cols-3">
        {PIPELINE_PAGES.map((page) => (
          <Link key={page.url} href={page.url}>
            <Card className="cursor-pointer transition-colors hover:border-primary/50">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <page.icon className="h-5 w-5 text-muted-foreground" />
                  <ArrowRight className="h-4 w-4 text-muted-foreground" />
                </div>
                <CardTitle className="text-base mt-2">{page.title}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">{page.description}</p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
