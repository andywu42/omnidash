/**
 * Integration Catalog Dashboard
 *
 * Displays all active platform integrations with live health status.
 * Data sourced from:
 *   GET /api/integrations
 *   GET /api/integrations/health (force refresh)
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Globe,
  RefreshCw,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  HelpCircle,
  Server,
  Webhook,
  Timer,
  Send,
  Database,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { POLLING_INTERVAL_SLOW } from '@/lib/constants/query-config';

// ============================================================================
// Types
// ============================================================================

interface IntegrationStatus {
  id: string;
  name: string;
  type: string;
  description: string;
  nodes: string[];
  envVars: string[];
  topics: string[];
  health: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  healthMessage: string;
  lastChecked: string | null;
}

interface CatalogResponse {
  catalogVersion: string;
  integrations: IntegrationStatus[];
}

// ============================================================================
// Helpers
// ============================================================================

const typeIcons: Record<string, typeof Globe> = {
  webhook: Webhook,
  poller: Timer,
  outbound: Send,
  infrastructure: Server,
};

function TypeIcon({ type }: { type: string }) {
  const Icon = typeIcons[type] ?? Database;
  return <Icon className="h-5 w-5 text-muted-foreground" />;
}

function HealthIndicator({ health }: { health: IntegrationStatus['health'] }) {
  switch (health) {
    case 'healthy':
      return <CheckCircle2 className="h-5 w-5 text-emerald-500" />;
    case 'degraded':
      return <AlertTriangle className="h-5 w-5 text-amber-500" />;
    case 'unhealthy':
      return <XCircle className="h-5 w-5 text-destructive" />;
    default:
      return <HelpCircle className="h-5 w-5 text-muted-foreground" />;
  }
}

function healthBadgeVariant(health: IntegrationStatus['health']): string {
  switch (health) {
    case 'healthy':
      return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300';
    case 'degraded':
      return 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300';
    case 'unhealthy':
      return 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300';
    default:
      return 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400';
  }
}

function fmtTimestamp(ts: string | null): string {
  if (!ts) return 'Never';
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? ts : date.toLocaleString();
}

// ============================================================================
// Component
// ============================================================================

export default function IntegrationCatalogDashboard() {
  const queryClient = useQueryClient();

  const {
    data,
    isLoading,
    error,
    isFetching,
  } = useQuery<CatalogResponse>({
    queryKey: ['integrations', 'catalog'],
    queryFn: async () => {
      const res = await fetch('/api/integrations', { credentials: 'include' });
      if (!res.ok) throw new Error(`${res.status}: ${res.statusText}`);
      return res.json();
    },
    refetchInterval: POLLING_INTERVAL_SLOW,
  });

  async function handleRefreshHealth() {
    try {
      const res = await fetch('/api/integrations/health', { credentials: 'include' });
      if (res.ok) {
        // Invalidate the main query to pick up fresh results
        await queryClient.invalidateQueries({ queryKey: ['integrations', 'catalog'] });
      }
    } catch {
      // Ignore — the main query will retry on its own
    }
  }

  const integrations = data?.integrations ?? [];
  const healthyCount = integrations.filter((i) => i.health === 'healthy').length;
  const unhealthyCount = integrations.filter((i) => i.health === 'unhealthy').length;
  const unknownCount = integrations.filter((i) => i.health === 'unknown').length;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Integration Catalog</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Active platform integrations with live health status
            {data?.catalogVersion && (
              <span className="ml-2 text-xs opacity-60">v{data.catalogVersion}</span>
            )}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void handleRefreshHealth()}
          disabled={isFetching}
          className="gap-2"
        >
          <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
          Check Health
        </Button>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          Failed to load integration catalog: {error instanceof Error ? error.message : 'Unknown error'}
        </div>
      )}

      {/* Summary bar */}
      {!isLoading && integrations.length > 0 && (
        <div className="flex gap-4 text-sm">
          <span className="flex items-center gap-1.5">
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            {healthyCount} healthy
          </span>
          {unhealthyCount > 0 && (
            <span className="flex items-center gap-1.5">
              <XCircle className="h-4 w-4 text-destructive" />
              {unhealthyCount} unhealthy
            </span>
          )}
          {unknownCount > 0 && (
            <span className="flex items-center gap-1.5">
              <HelpCircle className="h-4 w-4 text-muted-foreground" />
              {unknownCount} unknown
            </span>
          )}
          <span className="text-muted-foreground">
            {integrations.length} total integrations
          </span>
        </div>
      )}

      {/* Cards grid */}
      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[...Array(6)].map((_, i) => (
            <Skeleton key={i} className="h-48 rounded-lg" />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {integrations.map((integration) => (
            <Card key={integration.id} className="flex flex-col">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <TypeIcon type={integration.type} />
                    <CardTitle className="text-base">{integration.name}</CardTitle>
                  </div>
                  <HealthIndicator health={integration.health} />
                </div>
                <CardDescription className="mt-1 text-xs">
                  {integration.description}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex-1 space-y-3">
                {/* Health badge + message */}
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${healthBadgeVariant(integration.health)}`}
                  >
                    {integration.health}
                  </span>
                  <span className="text-xs text-muted-foreground truncate">
                    {integration.healthMessage}
                  </span>
                </div>

                {/* Type badge */}
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-xs">
                    {integration.type}
                  </Badge>
                  {integration.nodes.length > 0 && (
                    <span className="text-xs text-muted-foreground">
                      {integration.nodes.length} node{integration.nodes.length !== 1 ? 's' : ''}
                    </span>
                  )}
                  {integration.topics.length > 0 && (
                    <span className="text-xs text-muted-foreground">
                      {integration.topics.length} topic{integration.topics.length !== 1 ? 's' : ''}
                    </span>
                  )}
                </div>

                {/* Env vars */}
                {integration.envVars.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {integration.envVars.map((v) => (
                      <span
                        key={v}
                        className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono bg-muted"
                      >
                        {v}
                      </span>
                    ))}
                  </div>
                )}

                {/* Last checked */}
                <div className="text-[10px] text-muted-foreground">
                  Last checked: {fmtTimestamp(integration.lastChecked)}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
