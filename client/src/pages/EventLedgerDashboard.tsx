/**
 * Event Ledger Dashboard
 *
 * Displays the immutable event ledger from the omnibase_infra database.
 * Supports browsing recent events and searching by correlation ID,
 * event type, topic, or time range.
 *
 * Backed by: event_ledger table (via /api/ledger/* routes)
 */

import { useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
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
import {
  Database,
  Search,
  RefreshCw,
  BookOpen,
  Hash,
  Clock,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { LocalDataUnavailableBanner } from '@/components/LocalDataUnavailableBanner';

// ============================================================================
// Types
// ============================================================================

interface LedgerEntry {
  ledger_entry_id: string;
  topic: string;
  partition: number;
  kafka_offset: number;
  event_type: string | null;
  source: string | null;
  correlation_id: string | null;
  event_timestamp: string | null;
  ledger_written_at: string;
}

interface LedgerStats {
  total_entries: number;
  distinct_topics: number;
  earliest: string | null;
  latest: string | null;
}

interface LedgerRecentResponse {
  entries: LedgerEntry[];
  limit: number;
  offset: number;
}

interface LedgerQueryResponse {
  entries: LedgerEntry[];
  total: number;
  has_more: boolean;
  limit: number;
  offset: number;
}

// ============================================================================
// Helpers
// ============================================================================

function relativeTime(isoTs: string | null): string {
  if (!isoTs) return 'n/a';
  const ts = new Date(isoTs).getTime();
  if (isNaN(ts)) return 'n/a';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function topicBadgeColor(topic: string): 'default' | 'secondary' | 'outline' {
  if (topic.includes('.cmd.')) return 'secondary';
  if (topic.includes('.evt.')) return 'default';
  return 'outline';
}

function truncateId(id: string | null): string {
  if (!id) return '-';
  return id.length > 12 ? `${id.slice(0, 8)}...` : id;
}

// ============================================================================
// Sub-components
// ============================================================================

function StatCard({
  title,
  value,
  icon: Icon,
  isLoading,
}: {
  title: string;
  value: string;
  icon: React.ElementType;
  isLoading: boolean;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-8 w-24" />
        ) : (
          <div className="text-2xl font-bold tabular-nums">{value}</div>
        )}
      </CardContent>
    </Card>
  );
}

function LedgerTable({
  entries,
  isLoading,
  onCorrelationClick,
}: {
  entries: LedgerEntry[];
  isLoading: boolean;
  onCorrelationClick: (id: string) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Topic</TableHead>
          <TableHead>Event Type</TableHead>
          <TableHead>Source</TableHead>
          <TableHead>Correlation ID</TableHead>
          <TableHead className="text-right">Partition</TableHead>
          <TableHead className="text-right">Offset</TableHead>
          <TableHead className="text-right">When</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {isLoading ? (
          [...Array(5)].map((_, i) => (
            <TableRow key={i}>
              {[...Array(7)].map((__, j) => (
                <TableCell key={j}>
                  <Skeleton className="h-4 w-full" />
                </TableCell>
              ))}
            </TableRow>
          ))
        ) : entries.length === 0 ? (
          <TableRow>
            <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
              No ledger entries found. The event_ledger table may be empty or the query returned no
              results.
            </TableCell>
          </TableRow>
        ) : (
          entries.map((entry) => (
            <TableRow key={entry.ledger_entry_id}>
              <TableCell>
                <Badge variant={topicBadgeColor(entry.topic)} className="font-mono text-xs">
                  {entry.topic}
                </Badge>
              </TableCell>
              <TableCell className="font-mono text-xs">
                {entry.event_type ?? <span className="text-muted-foreground">-</span>}
              </TableCell>
              <TableCell className="text-xs">
                {entry.source ?? <span className="text-muted-foreground">-</span>}
              </TableCell>
              <TableCell>
                {entry.correlation_id ? (
                  <button
                    onClick={() => onCorrelationClick(entry.correlation_id!)}
                    className="font-mono text-xs text-blue-500 hover:underline cursor-pointer"
                    title={entry.correlation_id}
                  >
                    {truncateId(entry.correlation_id)}
                  </button>
                ) : (
                  <span className="text-muted-foreground text-xs">-</span>
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums text-xs">{entry.partition}</TableCell>
              <TableCell className="text-right tabular-nums text-xs">
                {entry.kafka_offset}
              </TableCell>
              <TableCell className="text-right text-xs text-muted-foreground">
                {relativeTime(entry.event_timestamp ?? entry.ledger_written_at)}
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export default function EventLedgerDashboard() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(0);
  const [searchCorrelationId, setSearchCorrelationId] = useState('');
  const [searchEventType, setSearchEventType] = useState('');
  const [searchTopic, setSearchTopic] = useState('');
  const [activeSearch, setActiveSearch] = useState<{
    correlation_id?: string;
    event_type?: string;
    topic?: string;
  } | null>(null);
  const PAGE_SIZE = 50;

  // Stats query
  const statsQuery = useQuery<LedgerStats>({
    queryKey: ['ledger', 'stats'],
    queryFn: async () => {
      const res = await fetch('/api/ledger/stats');
      if (!res.ok) throw new Error(`Stats failed: ${res.status}`);
      return res.json();
    },
    refetchInterval: 30_000,
  });

  // Recent entries query (when not searching)
  const recentQuery = useQuery<LedgerRecentResponse>({
    queryKey: ['ledger', 'recent', page],
    queryFn: async () => {
      const res = await fetch(`/api/ledger/recent?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`);
      if (!res.ok) throw new Error(`Recent failed: ${res.status}`);
      return res.json();
    },
    refetchInterval: 10_000,
    enabled: !activeSearch,
  });

  // Search query (when searching)
  const searchQuery = useQuery<LedgerQueryResponse>({
    queryKey: ['ledger', 'query', activeSearch, page],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (activeSearch?.correlation_id) params.set('correlation_id', activeSearch.correlation_id);
      if (activeSearch?.event_type) params.set('event_type', activeSearch.event_type);
      if (activeSearch?.topic) params.set('topic', activeSearch.topic);
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(page * PAGE_SIZE));
      const res = await fetch(`/api/ledger/query?${params}`);
      if (!res.ok) throw new Error(`Query failed: ${res.status}`);
      return res.json();
    },
    enabled: !!activeSearch,
  });

  const isUnavailable = statsQuery.isError && statsQuery.error?.message?.includes('503');

  const entries = activeSearch
    ? (searchQuery.data?.entries ?? [])
    : (recentQuery.data?.entries ?? []);
  const isLoading = activeSearch ? searchQuery.isLoading : recentQuery.isLoading;

  const handleSearch = useCallback(() => {
    const search: Record<string, string> = {};
    if (searchCorrelationId.trim()) search.correlation_id = searchCorrelationId.trim();
    if (searchEventType.trim()) search.event_type = searchEventType.trim();
    if (searchTopic.trim()) search.topic = searchTopic.trim();

    if (Object.keys(search).length === 0) {
      setActiveSearch(null);
    } else {
      setActiveSearch(search);
    }
    setPage(0);
  }, [searchCorrelationId, searchEventType, searchTopic]);

  const handleClearSearch = useCallback(() => {
    setSearchCorrelationId('');
    setSearchEventType('');
    setSearchTopic('');
    setActiveSearch(null);
    setPage(0);
  }, []);

  const handleCorrelationClick = useCallback((id: string) => {
    setSearchCorrelationId(id);
    setSearchEventType('');
    setSearchTopic('');
    setActiveSearch({ correlation_id: id });
    setPage(0);
  }, []);

  const stats = statsQuery.data;
  const statsLoading = statsQuery.isLoading;

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <BookOpen className="h-6 w-6" />
            Event Ledger
          </h1>
          <p className="text-muted-foreground">
            Immutable audit log of all events flowing through the ONEX event bus
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            queryClient.invalidateQueries({ queryKey: ['ledger'] });
          }}
        >
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>

      {isUnavailable && <LocalDataUnavailableBanner />}

      {/* Stats cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <StatCard
          title="Total Entries"
          value={stats?.total_entries?.toLocaleString() ?? '0'}
          icon={Database}
          isLoading={statsLoading}
        />
        <StatCard
          title="Distinct Topics"
          value={stats?.distinct_topics?.toLocaleString() ?? '0'}
          icon={Hash}
          isLoading={statsLoading}
        />
        <StatCard
          title="Earliest"
          value={stats?.earliest ? relativeTime(stats.earliest) : 'n/a'}
          icon={Clock}
          isLoading={statsLoading}
        />
        <StatCard
          title="Latest"
          value={stats?.latest ? relativeTime(stats.latest) : 'n/a'}
          icon={Clock}
          isLoading={statsLoading}
        />
      </div>

      {/* Search bar */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Search className="h-4 w-4" />
            Search Ledger
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-3 items-end">
            <div className="flex flex-col gap-1 min-w-[240px]">
              <label className="text-xs text-muted-foreground">Correlation ID</label>
              <Input
                placeholder="e.g. 550e8400-e29b..."
                value={searchCorrelationId}
                onChange={(e) => setSearchCorrelationId(e.target.value)}
                className="font-mono text-sm"
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              />
            </div>
            <div className="flex flex-col gap-1 min-w-[200px]">
              <label className="text-xs text-muted-foreground">Event Type</label>
              <Input
                placeholder="e.g. NodeRegistered"
                value={searchEventType}
                onChange={(e) => setSearchEventType(e.target.value)}
                className="text-sm"
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              />
            </div>
            <div className="flex flex-col gap-1 min-w-[240px]">
              <label className="text-xs text-muted-foreground">Topic</label>
              <Input
                placeholder="e.g. onex.evt.platform..."
                value={searchTopic}
                onChange={(e) => setSearchTopic(e.target.value)}
                className="font-mono text-sm"
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              />
            </div>
            <div className="flex gap-2">
              <Button onClick={handleSearch} size="sm">
                <Search className="h-4 w-4 mr-1" />
                Search
              </Button>
              {activeSearch && (
                <Button onClick={handleClearSearch} variant="outline" size="sm">
                  Clear
                </Button>
              )}
            </div>
          </div>
          {activeSearch && (
            <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
              <span>Filtering by:</span>
              {activeSearch.correlation_id && (
                <Badge variant="secondary" className="font-mono">
                  correlation_id: {truncateId(activeSearch.correlation_id)}
                </Badge>
              )}
              {activeSearch.event_type && (
                <Badge variant="secondary">event_type: {activeSearch.event_type}</Badge>
              )}
              {activeSearch.topic && (
                <Badge variant="secondary" className="font-mono">
                  topic: {activeSearch.topic}
                </Badge>
              )}
              {searchQuery.data && (
                <span>
                  ({searchQuery.data.total} result{searchQuery.data.total !== 1 ? 's' : ''})
                </span>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Entries table */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="h-4 w-4" />
            {activeSearch ? 'Search Results' : 'Recent Entries'}
          </CardTitle>
          <CardDescription>
            {activeSearch
              ? 'Filtered ledger entries matching your search criteria'
              : 'Most recent events written to the immutable audit ledger'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <LedgerTable
            entries={entries}
            isLoading={isLoading}
            onCorrelationClick={handleCorrelationClick}
          />

          {/* Pagination */}
          <div className="flex items-center justify-between mt-4">
            <span className="text-sm text-muted-foreground">
              Page {page + 1}
              {activeSearch && searchQuery.data
                ? ` of ${Math.max(1, Math.ceil(searchQuery.data.total / PAGE_SIZE))}`
                : ''}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
              >
                <ChevronLeft className="h-4 w-4" />
                Prev
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => p + 1)}
                disabled={entries.length < PAGE_SIZE}
              >
                Next
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
