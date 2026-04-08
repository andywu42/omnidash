/**
 * Agents Dashboard (OMN-6753)
 *
 * Shows registered agents from the agent registry with status and performance.
 * Data source: /api/agents (agent-registry-routes.ts, reads agent-registry.yaml)
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import { MetricCard } from '@/components/MetricCard';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { RefreshCw, Bot, Activity, CheckCircle2, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { POLLING_INTERVAL_SLOW, getPollingInterval } from '@/lib/constants/query-config';

interface AgentEntry {
  name: string;
  description?: string;
  status: string;
  capabilities?: Array<{ name: string; category: string }>;
  performance?: {
    totalExecutions?: number;
    successRate?: number;
    avgDuration?: number;
  };
}

interface AgentListResponse {
  agents: AgentEntry[];
  total: number;
}

export default function AgentsDashboard() {
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery<AgentListResponse>({
    queryKey: queryKeys.agents.list(),
    queryFn: async () => {
      const res = await fetch('/api/agents/agents');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: getPollingInterval(POLLING_INTERVAL_SLOW),
  });

  const agents = data?.agents ?? [];
  const activeCount = agents.filter((a) => a.status === 'active').length;
  const errorCount = agents.filter((a) => a.status === 'error').length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Agents</h1>
          <p className="text-muted-foreground mt-1">
            Registered agent inventory and runtime status
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => queryClient.invalidateQueries({ queryKey: queryKeys.agents.list() })}
        >
          <RefreshCw className="w-4 h-4 mr-2" />
          Refresh
        </Button>
      </div>

      {/* Summary cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <MetricCard
          label="Total Agents"
          value={isLoading ? '...' : String(agents.length)}
          icon={Bot}
          subtitle="Registered in agent-registry.yaml"
        />
        <MetricCard
          label="Active"
          value={isLoading ? '...' : String(activeCount)}
          icon={CheckCircle2}
          subtitle="Currently operational"
        />
        <MetricCard
          label="Errors"
          value={isLoading ? '...' : String(errorCount)}
          icon={AlertTriangle}
          subtitle="Agents with error status"
          className={errorCount > 0 ? 'border-red-500/30' : ''}
        />
        <MetricCard
          label="Capabilities"
          value={
            isLoading
              ? '...'
              : String(agents.reduce((sum, a) => sum + (a.capabilities?.length ?? 0), 0))
          }
          icon={Activity}
          subtitle="Total capability registrations"
        />
      </div>

      {/* Agent table */}
      <Card>
        <CardHeader>
          <CardTitle>Agent Registry</CardTitle>
          <CardDescription>All agents loaded from the agent definition registry</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : error ? (
            <div className="text-center py-8 text-muted-foreground">
              <AlertTriangle className="w-8 h-8 mx-auto mb-2 text-amber-500" />
              <p>Failed to load agent registry.</p>
              <p className="text-sm mt-1">
                Ensure the agent-registry.yaml file exists and the server can read it.
              </p>
            </div>
          ) : agents.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Bot className="w-8 h-8 mx-auto mb-2" />
              <p>No agents registered yet.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Agent</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Capabilities</TableHead>
                  <TableHead className="text-right">Executions</TableHead>
                  <TableHead className="text-right">Success Rate</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {agents.map((agent) => (
                  <TableRow key={agent.name}>
                    <TableCell>
                      <div>
                        <span className="font-medium">{agent.name}</span>
                        {agent.description && (
                          <p className="text-xs text-muted-foreground mt-0.5 max-w-md truncate">
                            {agent.description}
                          </p>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={cn(
                          agent.status === 'active' && 'border-green-500 text-green-500',
                          agent.status === 'error' && 'border-red-500 text-red-500',
                          agent.status === 'idle' && 'border-gray-500 text-gray-500'
                        )}
                      >
                        {agent.status}
                      </Badge>
                    </TableCell>
                    <TableCell>{agent.capabilities?.length ?? 0}</TableCell>
                    <TableCell className="text-right font-mono">
                      {agent.performance?.totalExecutions ?? 0}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {agent.performance?.successRate != null
                        ? `${(agent.performance.successRate * 100).toFixed(1)}%`
                        : '--'}
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
