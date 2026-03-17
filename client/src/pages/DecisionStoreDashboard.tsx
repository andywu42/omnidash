/**
 * Decision Store Dashboard (OMN-5280)
 *
 * Displays decision provenance data from the in-memory decision record store.
 * Source: /api/decisions/* endpoints (decision-records-routes.ts)
 *
 * Shows:
 * - Session selector (search/pick a session_id)
 * - Decision timeline (chronological list of decision cards)
 * - Intent-vs-plan comparison panel
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { FileSearch, Clock, CheckCircle2, GitFork, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DataSourceEmptyState } from '@/components/EmptyState';
import type {
  DecisionTimelineResponse,
  IntentVsPlanResponse,
  DecisionSessionsResponse,
  DecisionTimelineRow,
  IntentPlanField,
} from '@shared/decision-record-types';

// ============================================================================
// Helpers
// ============================================================================

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

function decisionTypeBadge(
  type: string
): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (type === 'model_select') return 'default';
  if (type === 'tool_select') return 'secondary';
  if (type === 'route_select') return 'outline';
  return 'secondary';
}

function originColor(origin: string): string {
  if (origin === 'user_specified') return 'text-green-500';
  if (origin === 'inferred') return 'text-blue-500';
  return 'text-muted-foreground';
}

// ============================================================================
// Fetch functions
// ============================================================================

async function fetchSessions(): Promise<DecisionSessionsResponse> {
  const res = await fetch('/api/decisions/sessions');
  if (!res.ok) throw new Error('Failed to fetch decision sessions');
  return res.json() as Promise<DecisionSessionsResponse>;
}

async function fetchTimeline(sessionId: string): Promise<DecisionTimelineResponse> {
  const res = await fetch(`/api/decisions/timeline?session_id=${encodeURIComponent(sessionId)}`);
  if (!res.ok) throw new Error('Failed to fetch decision timeline');
  return res.json() as Promise<DecisionTimelineResponse>;
}

async function fetchIntentVsPlan(sessionId: string): Promise<IntentVsPlanResponse> {
  const res = await fetch(
    `/api/decisions/intent-vs-plan?session_id=${encodeURIComponent(sessionId)}`
  );
  if (!res.ok) {
    if (res.status === 404) return { session_id: sessionId, executed_at: '', fields: [] };
    throw new Error('Failed to fetch intent-vs-plan data');
  }
  return res.json() as Promise<IntentVsPlanResponse>;
}

// ============================================================================
// Sub-components
// ============================================================================

function DecisionTimelineCard({ row }: { row: DecisionTimelineRow }) {
  return (
    <div className="flex gap-4 py-3 border-b border-border last:border-0">
      <div className="flex flex-col items-center">
        <div className="h-2 w-2 rounded-full bg-primary mt-1.5" />
        <div className="w-px flex-1 bg-border mt-1" />
      </div>
      <div className="flex-1 pb-2">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant={decisionTypeBadge(row.decision_type)} className="text-xs">
            {row.decision_type}
          </Badge>
          <span className="font-mono text-sm font-medium">{row.selected_candidate}</span>
          <span className="text-xs text-muted-foreground ml-auto">
            {relativeTime(row.decided_at)}
          </span>
        </div>
        <div className="mt-1 text-xs text-muted-foreground flex items-center gap-3">
          <span className="flex items-center gap-1">
            <GitFork className="h-3 w-3" />
            {row.candidates_count} candidate{row.candidates_count !== 1 ? 's' : ''}
          </span>
          <span className="font-mono opacity-60">{row.decision_id.slice(0, 8)}…</span>
        </div>
        {row.full_record.agent_rationale && (
          <p className="mt-1.5 text-xs text-muted-foreground italic line-clamp-2">
            {row.full_record.agent_rationale}
          </p>
        )}
      </div>
    </div>
  );
}

function IntentVsPlanTable({
  fields,
  isLoading,
}: {
  fields: IntentPlanField[];
  isLoading: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4" />
          Intent vs Resolved Plan
        </CardTitle>
        <CardDescription>
          How each decision field was resolved relative to user intent
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {[...Array(4)].map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : fields.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No intent-vs-plan data for this session.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Field</TableHead>
                <TableHead>Intent</TableHead>
                <TableHead>Resolved</TableHead>
                <TableHead>Origin</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {fields.map((field, idx) => (
                <TableRow key={`${field.field_name}-${idx}`}>
                  <TableCell className="font-mono text-xs">{field.field_name}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {field.intent_value ?? (
                      <span className="italic opacity-60">(not specified)</span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{field.resolved_value}</TableCell>
                  <TableCell>
                    <span className={cn('text-xs font-medium', originColor(field.origin))}>
                      {field.origin}
                    </span>
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

export function DecisionStoreDashboard() {
  const [sessionInput, setSessionInput] = useState('');
  const [activeSessionId, setActiveSessionId] = useState('');

  const { data: sessionsData, isLoading: sessionsLoading } = useQuery({
    queryKey: queryKeys.decisions.sessions(),
    queryFn: fetchSessions,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const hasActiveSession = activeSessionId.trim().length > 0;

  const { data: timelineData, isLoading: timelineLoading } = useQuery({
    queryKey: queryKeys.decisions.timeline(activeSessionId),
    queryFn: () => fetchTimeline(activeSessionId),
    enabled: hasActiveSession,
    staleTime: 15_000,
  });

  const { data: intentData, isLoading: intentLoading } = useQuery({
    queryKey: queryKeys.decisions.intentVsPlan(activeSessionId),
    queryFn: () => fetchIntentVsPlan(activeSessionId),
    enabled: hasActiveSession,
    staleTime: 15_000,
  });

  const sessions = sessionsData?.sessions ?? [];
  const timelineRows = timelineData?.rows ?? [];
  const intentFields = intentData?.fields ?? [];

  const handleSessionSelect = (sessionId: string) => {
    setSessionInput(sessionId);
    setActiveSessionId(sessionId);
  };

  const handleSessionSearch = () => {
    const trimmed = sessionInput.trim();
    if (trimmed) setActiveSessionId(trimmed);
  };

  const isEmpty = !sessionsLoading && sessions.length === 0;

  return (
    <div className="space-y-6" data-testid="page-decision-store-dashboard">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Decision Store</h1>
        <p className="text-muted-foreground">
          Decision provenance and intent-vs-plan comparison from{' '}
          <code className="text-xs">/api/decisions/*</code>
        </p>
      </div>

      {isEmpty && (
        <DataSourceEmptyState
          sourceName="Decision Records"
          producerName="omniintelligence routing engine"
          instructions="Decision records are produced when the routing engine selects a model, tool, or route."
        />
      )}

      {/* Session Selector */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileSearch className="h-4 w-4" />
            Session Selector
          </CardTitle>
          <CardDescription>
            Pick a session ID from the list or enter one manually
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input
              placeholder="Enter session ID…"
              value={sessionInput}
              onChange={(e) => setSessionInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSessionSearch();
              }}
              className="font-mono text-sm"
            />
            <button
              onClick={handleSessionSearch}
              className="px-4 py-2 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              Load
            </button>
          </div>

          {sessionsLoading ? (
            <div className="space-y-1">
              {[...Array(3)].map((_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : sessions.length > 0 ? (
            <div className="max-h-48 overflow-y-auto space-y-1">
              {sessions.map((session) => (
                <button
                  key={session.session_id}
                  onClick={() => handleSessionSelect(session.session_id)}
                  className={cn(
                    'w-full text-left px-3 py-2 rounded-md text-sm hover:bg-accent transition-colors',
                    activeSessionId === session.session_id && 'bg-sidebar-accent'
                  )}
                >
                  <span className="font-mono text-xs block truncate">{session.session_id}</span>
                  <span className="text-xs text-muted-foreground">
                    {session.decision_count} decision{session.decision_count !== 1 ? 's' : ''} ·{' '}
                    {relativeTime(session.last_decided_at)}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* No session selected state */}
      {!hasActiveSession && !isEmpty && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
          <AlertCircle className="h-4 w-4" />
          Select a session above to view its decision timeline and intent-vs-plan comparison.
        </div>
      )}

      {/* Decision Timeline */}
      {hasActiveSession && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="h-4 w-4" />
              Decision Timeline
            </CardTitle>
            <CardDescription>
              Chronological decision sequence for session{' '}
              <code className="text-xs">{activeSessionId}</code>
            </CardDescription>
          </CardHeader>
          <CardContent>
            {timelineLoading ? (
              <div className="space-y-3">
                {[...Array(4)].map((_, i) => (
                  <Skeleton key={i} className="h-14 w-full" />
                ))}
              </div>
            ) : timelineRows.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">
                No decision records found for this session.
              </p>
            ) : (
              <div>
                {timelineRows.map((row) => (
                  <DecisionTimelineCard key={row.decision_id} row={row} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Intent vs Plan */}
      {hasActiveSession && (
        <IntentVsPlanTable fields={intentFields} isLoading={intentLoading} />
      )}
    </div>
  );
}

export default DecisionStoreDashboard;
