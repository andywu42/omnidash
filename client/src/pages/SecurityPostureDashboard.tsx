/**
 * Security Posture Dashboard (feature-hookup Phase 4)
 *
 * Shows security scan workflow status across all repos:
 * - Workflow run conclusions (pass/fail/in-progress)
 * - SBOM generation status per Docker image
 * - Security scan coverage overview
 *
 * Data sourced from GitHub Actions API via /api/security-posture.
 * Requires GH_PAT env var on the server for GitHub API access.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import { MetricCard } from '@/components/MetricCard';
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
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Shield,
  Package,
  Clock,
  ExternalLink,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { POLLING_INTERVAL_SLOW, getPollingInterval } from '@/lib/constants/query-config';

// ============================================================================
// Types
// ============================================================================

interface WorkflowRunSummary {
  repo: string;
  workflow: string;
  conclusion: string | null;
  status: string;
  runNumber: number;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  headBranch: string;
  headSha: string;
}

interface SecurityPostureResponse {
  configured: boolean;
  runs: WorkflowRunSummary[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    inProgress: number;
  };
  fetchedAt: string;
}

interface SbomImage {
  image: string;
  repo: string;
  workflow: string;
  lastBuild: {
    conclusion: string | null;
    createdAt: string;
    runNumber: number;
    htmlUrl: string;
    headSha: string;
  } | null;
  sbomAvailable: boolean;
}

interface SbomResponse {
  configured: boolean;
  images: SbomImage[];
}

// ============================================================================
// Fetchers
// ============================================================================

async function fetchPosture(): Promise<SecurityPostureResponse> {
  const res = await fetch('/api/security-posture', { credentials: 'include' });
  if (!res.ok) throw new Error('Failed to fetch security posture');
  return res.json() as Promise<SecurityPostureResponse>;
}

async function fetchSbom(): Promise<SbomResponse> {
  const res = await fetch('/api/security-posture/sbom', { credentials: 'include' });
  if (!res.ok) throw new Error('Failed to fetch SBOM data');
  return res.json() as Promise<SbomResponse>;
}

// ============================================================================
// Helpers
// ============================================================================

function formatTimestamp(ts: string): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function conclusionBadge(conclusion: string | null, status: string) {
  if (status !== 'completed') {
    return (
      <Badge variant="outline" className="border-blue-500 text-blue-600 text-xs">
        <Clock className="h-3 w-3 mr-1" />
        {status}
      </Badge>
    );
  }

  switch (conclusion) {
    case 'success':
      return (
        <Badge variant="outline" className="border-green-500 text-green-600 text-xs">
          <CheckCircle2 className="h-3 w-3 mr-1" />
          pass
        </Badge>
      );
    case 'failure':
      return (
        <Badge variant="outline" className="border-red-500 text-red-600 text-xs">
          <XCircle className="h-3 w-3 mr-1" />
          fail
        </Badge>
      );
    default:
      return (
        <Badge variant="outline" className="text-xs">
          {conclusion ?? 'unknown'}
        </Badge>
      );
  }
}

function workflowDisplayName(workflow: string): string {
  return workflow
    .replace('.yml', '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ============================================================================
// SecurityPostureDashboard
// ============================================================================

export default function SecurityPostureDashboard() {
  const queryClient = useQueryClient();
  const pollingInterval = getPollingInterval(POLLING_INTERVAL_SLOW);

  const postureQuery = useQuery<SecurityPostureResponse>({
    queryKey: queryKeys.securityPosture.runs,
    queryFn: fetchPosture,
    refetchInterval: pollingInterval,
    staleTime: 60_000,
  });

  const sbomQuery = useQuery<SbomResponse>({
    queryKey: queryKeys.securityPosture.sbom,
    queryFn: fetchSbom,
    refetchInterval: pollingInterval,
    staleTime: 60_000,
  });

  function handleRefresh() {
    void queryClient.invalidateQueries({ queryKey: queryKeys.securityPosture.all });
  }

  const isLoading = postureQuery.isLoading || sbomQuery.isLoading;
  const isError = postureQuery.isError || sbomQuery.isError;
  const posture = postureQuery.data;
  const sbom = sbomQuery.data;

  const summary = posture?.summary ?? { total: 0, passed: 0, failed: 0, inProgress: 0 };

  const postureStatus =
    summary.failed > 0
      ? ('error' as const)
      : summary.inProgress > 0
        ? ('warning' as const)
        : summary.passed > 0
          ? ('healthy' as const)
          : undefined;

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Shield className="h-6 w-6" />
            Security Posture
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            CI security scan results and SBOM generation status
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isLoading}>
          <RefreshCw className={cn('h-4 w-4 mr-1', isLoading && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {/* Not configured banner */}
      {posture && !posture.configured && (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>GitHub API not configured</AlertTitle>
          <AlertDescription>
            Set <code className="text-xs">GH_PAT</code> environment variable to enable security
            posture data from GitHub Actions.
          </AlertDescription>
        </Alert>
      )}

      {/* Error banner */}
      {isError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Error loading security data</AlertTitle>
          <AlertDescription>Check server logs for details.</AlertDescription>
        </Alert>
      )}

      {/* Summary metric cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {isLoading ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)
        ) : (
          <>
            <MetricCard
              label="Security Scans"
              value={summary.total}
              subtitle="workflows tracked"
              icon={Shield}
              status={postureStatus}
            />
            <MetricCard
              label="Passing"
              value={summary.passed}
              subtitle="scans passing"
              icon={CheckCircle2}
              status="healthy"
            />
            <MetricCard
              label="Failing"
              value={summary.failed}
              subtitle="scans failing"
              icon={XCircle}
              status={summary.failed === 0 ? 'healthy' : 'error'}
            />
            <MetricCard
              label="SBOM Images"
              value={sbom?.images?.filter((i) => i.sbomAvailable).length ?? 0}
              subtitle={`of ${sbom?.images?.length ?? 0} images`}
              icon={Package}
            />
          </>
        )}
      </div>

      {/* Workflow runs table */}
      <Card>
        <CardHeader>
          <CardTitle>Security Workflow Results</CardTitle>
          <CardDescription>
            Latest CI security scan conclusions per repo (main branch)
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-48 w-full" />
          ) : !posture?.configured ? (
            <div className="flex items-center justify-center h-24 text-muted-foreground text-sm">
              Configure GH_PAT to view workflow results.
            </div>
          ) : posture.runs.length === 0 ? (
            <div className="flex items-center justify-center h-24 text-muted-foreground text-sm">
              No workflow runs found.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Repository</TableHead>
                  <TableHead>Workflow</TableHead>
                  <TableHead className="text-center">Result</TableHead>
                  <TableHead>Run</TableHead>
                  <TableHead>Timestamp</TableHead>
                  <TableHead>Commit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {posture.runs.map((run) => (
                  <TableRow key={`${run.repo}-${run.workflow}-${run.runNumber}`}>
                    <TableCell className="font-mono text-xs">{run.repo}</TableCell>
                    <TableCell className="text-xs">{workflowDisplayName(run.workflow)}</TableCell>
                    <TableCell className="text-center">
                      {conclusionBadge(run.conclusion, run.status)}
                    </TableCell>
                    <TableCell className="text-xs">
                      <a
                        href={run.htmlUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-blue-600 hover:underline"
                      >
                        #{run.runNumber}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                      {formatTimestamp(run.createdAt)}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {run.headSha.slice(0, 7)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* SBOM status */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Package className="h-5 w-5" />
            SBOM Generation
          </CardTitle>
          <CardDescription>
            Software Bill of Materials availability per Docker image
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : !sbom?.configured ? (
            <div className="flex items-center justify-center h-24 text-muted-foreground text-sm">
              Configure GH_PAT to view SBOM status.
            </div>
          ) : sbom.images.length === 0 ? (
            <div className="flex items-center justify-center h-24 text-muted-foreground text-sm">
              No images tracked.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Image</TableHead>
                  <TableHead className="text-center">SBOM</TableHead>
                  <TableHead>Last Build</TableHead>
                  <TableHead>Commit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sbom.images.map((img) => (
                  <TableRow key={img.image}>
                    <TableCell className="font-mono text-xs">{img.image}</TableCell>
                    <TableCell className="text-center">
                      {img.sbomAvailable ? (
                        <Badge
                          variant="outline"
                          className="border-green-500 text-green-600 text-xs"
                        >
                          <CheckCircle2 className="h-3 w-3 mr-1" />
                          available
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="border-amber-500 text-amber-600 text-xs"
                        >
                          <AlertTriangle className="h-3 w-3 mr-1" />
                          pending
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {img.lastBuild ? (
                        <a
                          href={img.lastBuild.htmlUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 text-blue-600 hover:underline"
                        >
                          #{img.lastBuild.runNumber} ({formatTimestamp(img.lastBuild.createdAt)})
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : (
                        '---'
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {img.lastBuild?.headSha?.slice(0, 7) ?? '---'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
