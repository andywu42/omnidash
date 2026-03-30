/**
 * Agent Coordination Dashboard (OMN-7036)
 *
 * Unified cross-surface timeline of agent team events.
 * Shows task-assigned, task-progress, task-completed, and evidence-written
 * events from all dispatch surfaces (team_worker, headless_claude, local_llm).
 *
 * Data source: GET /api/team-coordination
 * Kafka topics:
 *   onex.evt.omniclaude.task-assigned.v1
 *   onex.evt.omniclaude.task-progress.v1
 *   onex.evt.omniclaude.task-completed.v1
 *   onex.evt.omniclaude.evidence-written.v1
 *
 * Cost column deferred to Phase 5.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
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
import { Users, Bot, Terminal, Cpu, Clock, CheckCircle2, PlayCircle, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';

// ============================================================================
// Types
// ============================================================================

interface TeamEvent {
  event_id: string;
  correlation_id: string;
  task_id: string;
  event_type: string;
  dispatch_surface: string;
  agent_model: string | null;
  status: string | null;
  payload: string | null;
  emitted_at: string;
}

interface TeamEventsSummary {
  total_events: number;
  surface_counts: Record<string, number>;
  event_type_counts: Record<string, number>;
}

interface TeamEventsResponse {
  recent: TeamEvent[];
  summary: TeamEventsSummary;
}

// ============================================================================
// Surface color coding
// ============================================================================

const SURFACE_CONFIG: Record<
  string,
  { label: string; color: string; bgColor: string; icon: typeof Bot }
> = {
  team_worker: {
    label: 'Team Worker',
    color: 'text-blue-600 dark:text-blue-400',
    bgColor: 'bg-blue-100 dark:bg-blue-900/30',
    icon: Users,
  },
  headless_claude: {
    label: 'Headless Claude',
    color: 'text-purple-600 dark:text-purple-400',
    bgColor: 'bg-purple-100 dark:bg-purple-900/30',
    icon: Terminal,
  },
  local_llm: {
    label: 'Local LLM',
    color: 'text-amber-600 dark:text-amber-400',
    bgColor: 'bg-amber-100 dark:bg-amber-900/30',
    icon: Cpu,
  },
};

const EVENT_TYPE_CONFIG: Record<string, { label: string; icon: typeof Clock }> = {
  'task-assigned': { label: 'Assigned', icon: PlayCircle },
  'task-progress': { label: 'Progress', icon: Clock },
  'task-completed': { label: 'Completed', icon: CheckCircle2 },
  'evidence-written': { label: 'Evidence', icon: FileText },
};

function getSurfaceConfig(surface: string) {
  return (
    SURFACE_CONFIG[surface] || {
      label: surface,
      color: 'text-gray-600 dark:text-gray-400',
      bgColor: 'bg-gray-100 dark:bg-gray-900/30',
      icon: Bot,
    }
  );
}

function getEventTypeConfig(eventType: string) {
  return EVENT_TYPE_CONFIG[eventType] || { label: eventType, icon: Clock };
}

function formatAge(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h ago`;
  }
  if (hours > 0) return `${hours}h ${minutes}m ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}

// ============================================================================
// Component
// ============================================================================

export default function AgentCoordinationDashboard() {
  const [surfaceFilter, setSurfaceFilter] = useState<string>('all');

  const { data, isLoading, error } = useQuery<TeamEventsResponse>({
    queryKey: ['team-coordination', surfaceFilter],
    queryFn: async () => {
      const params = surfaceFilter !== 'all' ? `?surface=${surfaceFilter}` : '';
      const res = await fetch(`/api/team-coordination${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 10_000,
  });

  const summary = data?.summary;
  const events = data?.recent ?? [];

  return (
    <div className="space-y-6" data-testid="agent-coordination-page">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Agent Coordination</h1>
          <p className="text-muted-foreground">
            Unified timeline of agent task events across all dispatch surfaces
          </p>
        </div>
        <Select value={surfaceFilter} onValueChange={setSurfaceFilter}>
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="Filter by surface" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Surfaces</SelectItem>
            <SelectItem value="team_worker">Team Worker</SelectItem>
            <SelectItem value="headless_claude">Headless Claude</SelectItem>
            <SelectItem value="local_llm">Local LLM</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total Events</CardDescription>
            <CardTitle className="text-3xl">
              {isLoading ? <Skeleton className="h-9 w-16" /> : (summary?.total_events ?? 0)}
            </CardTitle>
          </CardHeader>
        </Card>
        {Object.entries(SURFACE_CONFIG).map(([key, config]) => {
          const SurfaceIcon = config.icon;
          const count = summary?.surface_counts[key] ?? 0;
          return (
            <Card key={key}>
              <CardHeader className="pb-2">
                <CardDescription className="flex items-center gap-1.5">
                  <SurfaceIcon className={cn('h-3.5 w-3.5', config.color)} />
                  {config.label}
                </CardDescription>
                <CardTitle className="text-3xl">
                  {isLoading ? <Skeleton className="h-9 w-16" /> : count}
                </CardTitle>
              </CardHeader>
            </Card>
          );
        })}
      </div>

      {/* Event timeline table */}
      <Card>
        <CardHeader>
          <CardTitle>Event Timeline</CardTitle>
          <CardDescription>Task lifecycle events ordered by emission time</CardDescription>
        </CardHeader>
        <CardContent>
          {error ? (
            <div className="text-center py-8 text-destructive">
              Failed to load agent coordination data
            </div>
          ) : isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : events.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Users className="h-12 w-12 mx-auto mb-3 opacity-50" />
              <p className="text-lg font-medium">No team events yet</p>
              <p className="text-sm">Events will appear when agent tasks are dispatched</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Task</TableHead>
                  <TableHead>Event</TableHead>
                  <TableHead>Surface</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.map((event) => {
                  const surfaceCfg = getSurfaceConfig(event.dispatch_surface);
                  const eventCfg = getEventTypeConfig(event.event_type);
                  const EventIcon = eventCfg.icon;
                  const SurfaceIcon = surfaceCfg.icon;

                  return (
                    <TableRow key={event.event_id} data-testid={`team-event-${event.event_id}`}>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {formatAge(event.emitted_at)}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{event.task_id}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <EventIcon className="h-3.5 w-3.5 text-muted-foreground" />
                          <span className="text-sm">{eventCfg.label}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="secondary"
                          className={cn('text-xs', surfaceCfg.bgColor, surfaceCfg.color)}
                        >
                          <SurfaceIcon className="h-3 w-3 mr-1" />
                          {surfaceCfg.label}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {event.agent_model || '-'}
                      </TableCell>
                      <TableCell>
                        {event.status ? (
                          <Badge variant="outline" className="text-xs">
                            {event.status}
                          </Badge>
                        ) : (
                          '-'
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
