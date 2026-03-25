/**
 * PatternLearning Dashboard
 *
 * PATLEARN-focused dashboard with evidence-based score debugging.
 * Part of OMN-1699: Pattern Dashboard with Evidence-Based Score Debugging
 */

import {
  useState,
  useMemo,
  useCallback,
  useDeferredValue,
  useEffect,
  useRef,
  Component,
  type ReactNode,
  type ErrorInfo,
} from 'react';
import { useFeatureStaleness } from '@/hooks/useStaleness';
import { StalenessIndicator } from '@/components/StalenessIndicator';
import { useSearch } from 'wouter';
import { useQuery, useInfiniteQuery } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  RefreshCw,
  Database,
  CheckCircle,
  Clock,
  Archive,
  Filter,
  X,
  Search,
  Loader2,
  AlertCircle,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { patlearnSource, type PatlearnArtifact, type LifecycleState } from '@/lib/data-sources';
import { useDemoMode } from '@/contexts/DemoModeContext';
import { DemoBanner } from '@/components/DemoBanner';
import {
  LifecycleStateBadge,
  PatternScoreDebugger,
  PatternStatusDistribution,
  PatternActivityTimeline,
  PatternSuccessRateTrends,
  TopPatternsTable,
} from '@/components/pattern';
import { POLLING_INTERVAL_MEDIUM, getPollingInterval } from '@/lib/constants/query-config';
import { queryKeys } from '@/lib/query-keys';

// ===========================
// Constants
// ===========================

/** Page size for infinite query pagination */
const PAGE_SIZE = 100;

/** Limit options for display filtering (client-side) */
const LIMIT_OPTIONS = [25, 50, 100, 250] as const;

/** Available lifecycle states for filtering */
const LIFECYCLE_STATES: LifecycleState[] = ['candidate', 'provisional', 'validated', 'deprecated'];

/** Valid limit options as a Set for O(1) lookup */
const VALID_LIMITS = new Set(LIMIT_OPTIONS);

/** Default limit value */
const DEFAULT_LIMIT = 50;

// ===========================
// URL Param Helpers
// ===========================

/**
 * Validates that a string is a valid LifecycleState
 */
function isValidLifecycleState(value: string | null): value is LifecycleState {
  return value !== null && LIFECYCLE_STATES.includes(value as LifecycleState);
}

/**
 * Validates and parses a limit value from URL
 * Returns DEFAULT_LIMIT if invalid
 */
function parseLimit(value: string | null): number {
  if (!value) return DEFAULT_LIMIT;
  const parsed = parseInt(value, 10);
  return VALID_LIMITS.has(parsed as (typeof LIMIT_OPTIONS)[number]) ? parsed : DEFAULT_LIMIT;
}

/**
 * Sanitizes search input to prevent XSS
 * Removes HTML tags and trims whitespace
 */
function sanitizeSearch(value: string | null): string {
  if (!value) return '';
  // Remove HTML tags and trim - basic XSS prevention
  return value
    .replace(/<[^>]*>/g, '')
    .trim()
    .slice(0, 200);
}

/**
 * Sanitizes pattern type input to prevent XSS
 * Only allows alphanumeric characters, hyphens, and underscores
 * Returns null if value is empty after sanitization
 */
function sanitizePatternType(value: string | null): string | null {
  if (!value) return null;
  // Remove HTML tags first (XSS prevention)
  const noHtml = value.replace(/<[^>]*>/g, '');
  // Keep only alphanumeric, hyphens, and underscores
  const sanitized = noHtml
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .trim()
    .slice(0, 100);
  // Return null if empty after sanitization
  return sanitized || null;
}

/**
 * Parses URL search params into FilterState
 */
function parseFiltersFromURL(searchString: string): FilterState {
  const params = new URLSearchParams(searchString);

  const stateParam = params.get('state');
  const typeParam = params.get('type');
  const searchParam = params.get('search');
  const limitParam = params.get('limit');

  return {
    state: isValidLifecycleState(stateParam) ? stateParam : null,
    patternType: sanitizePatternType(typeParam),
    search: sanitizeSearch(searchParam),
    limit: parseLimit(limitParam),
  };
}

/**
 * Serializes FilterState to URL search params string
 * Omits default values to keep URLs clean
 */
function serializeFiltersToURL(filters: FilterState): string {
  const params = new URLSearchParams();

  if (filters.state) {
    params.set('state', filters.state);
  }
  if (filters.patternType) {
    params.set('type', filters.patternType);
  }
  if (filters.search) {
    params.set('search', filters.search);
  }
  if (filters.limit !== DEFAULT_LIMIT) {
    params.set('limit', String(filters.limit));
  }

  return params.toString();
}

// ===========================
// Error Boundary
// ===========================

/**
 * Error boundary for PatternLearning dashboard
 * Catches rendering errors and displays a fallback UI
 */
class PatternLearningErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[PatternLearning] Render error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="p-8 text-center" data-testid="page-pattern-learning-error">
          <h2 className="text-xl font-semibold text-destructive mb-2">Something went wrong</h2>
          <p className="text-muted-foreground mb-4">
            {this.state.error?.message || 'An unexpected error occurred'}
          </p>
          <Button variant="outline" onClick={() => this.setState({ hasError: false, error: null })}>
            Try again
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ===========================
// Types
// ===========================

interface FilterState {
  state: LifecycleState | null;
  patternType: string | null;
  search: string;
  limit: number;
}

// ===========================
// Stats Card Component
// ===========================

function StatsCard({
  title,
  value,
  icon: Icon,
  description,
}: {
  title: string;
  value: number | string;
  icon: React.ElementType;
  description?: string;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </CardContent>
    </Card>
  );
}

// ===========================
// Main Dashboard Component
// ===========================

function PatternLearningContent() {
  const { isDemoMode } = useDemoMode();
  const patternsLastUpdated = useFeatureStaleness('patterns');

  // Get URL search string for initial filter state
  const searchString = useSearch();

  // Track if this is the initial mount to avoid URL update on first render
  const isInitialMount = useRef(true);

  // Initialize filter state from URL params
  const [filters, setFilters] = useState<FilterState>(() => parseFiltersFromURL(searchString));

  // Sync filter state to URL when it changes (but not on initial mount)
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }

    const newSearchString = serializeFiltersToURL(filters);
    const newUrl = newSearchString
      ? `${window.location.pathname}?${newSearchString}`
      : window.location.pathname;

    // Use replaceState to avoid polluting browser history
    window.history.replaceState({}, '', newUrl);
  }, [filters]);

  // Defer the search value to avoid excessive re-renders during rapid typing
  // The input shows typed characters immediately, but filtering uses the deferred value
  const deferredSearch = useDeferredValue(filters.search);

  // Detect when search filtering is pending (input value differs from deferred value)
  const isSearchPending = filters.search !== deferredSearch;

  const [selectedArtifact, setSelectedArtifact] = useState<PatlearnArtifact | null>(null);
  const [debuggerOpen, setDebuggerOpen] = useState(false);

  // Track if we're using demo data (database unavailable)
  const [isUsingDemoData, setIsUsingDemoData] = useState(false);

  // Fetch summary metrics
  const {
    data: summary,
    isLoading: summaryLoading,
    isError: summaryError,
    error: summaryErrorData,
    refetch: refetchSummary,
  } = useQuery({
    queryKey: queryKeys.patlearn.summary('24h'),
    queryFn: () => patlearnSource.summary('24h', { demoMode: isDemoMode }),
    refetchInterval: getPollingInterval(POLLING_INTERVAL_MEDIUM),
    staleTime: 30_000, // 30 seconds - prevents unnecessary refetches on remount
  });

  // Fetch patterns with infinite query for paginated loading
  const {
    data: patternsData,
    isLoading: patternsLoading,
    isError: patternsError,
    error: patternsErrorData,
    refetch: refetchPatterns,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: queryKeys.patlearn.list('infinite'),
    queryFn: ({ pageParam = 0 }) =>
      patlearnSource.list(
        {
          limit: PAGE_SIZE,
          offset: pageParam,
          sort: 'score',
          order: 'desc',
        },
        { demoMode: isDemoMode }
      ),
    getNextPageParam: (lastPage, allPages) => {
      // If we got a full page, there might be more
      if (lastPage.length === PAGE_SIZE) {
        return allPages.length * PAGE_SIZE;
      }
      return undefined; // No more pages
    },
    initialPageParam: 0,
    refetchInterval: getPollingInterval(POLLING_INTERVAL_MEDIUM),
    staleTime: 30_000, // 30 seconds - prevents unnecessary refetches on remount
  });

  // Flatten pages into single array for filtering
  const patterns = useMemo(() => patternsData?.pages.flat() ?? [], [patternsData]);

  // Detect if we're using demo data (check for __demo flag in metadata)
  useEffect(() => {
    if (patterns.length > 0) {
      const hasDemoData = patterns.some((p) => p.metadata?.__demo === true);
      setIsUsingDemoData(hasDemoData);
    }
  }, [patterns]);

  // Derive unique pattern types from the data
  const availablePatternTypes = useMemo(() => {
    if (!patterns.length) return [];
    const types = new Set(patterns.map((p) => p.patternType));
    return Array.from(types).sort();
  }, [patterns]);

  // Client-side filtering with useMemo
  // Uses deferredSearch to avoid re-filtering on every keystroke
  const filteredPatterns = useMemo(() => {
    if (!patterns.length) return [];

    let result = patterns;

    // Filter by lifecycle state
    if (filters.state) {
      result = result.filter((p) => p.lifecycleState === filters.state);
    }

    // Filter by pattern type
    if (filters.patternType) {
      result = result.filter((p) => p.patternType === filters.patternType);
    }

    // Filter by search term (uses deferred value for smoother typing)
    if (deferredSearch) {
      const searchLower = deferredSearch.toLowerCase();
      result = result.filter(
        (p) =>
          p.patternName.toLowerCase().includes(searchLower) ||
          p.patternType.toLowerCase().includes(searchLower) ||
          (p.language && p.language.toLowerCase().includes(searchLower))
      );
    }

    // Return all filtered patterns (no limit) - widgets need full dataset for analytics
    return result;
  }, [patterns, filters.state, filters.patternType, deferredSearch]);

  // Paginated patterns for table display only
  // Separating this from filteredPatterns ensures widgets analyze all data
  const paginatedPatterns = useMemo(
    () => filteredPatterns.slice(0, filters.limit),
    [filteredPatterns, filters.limit]
  );

  // Check if any filters are active
  const hasActiveFilters = filters.state || filters.patternType || filters.search;

  // Clear all filters
  const clearFilters = useCallback(() => {
    setFilters((prev) => ({
      ...prev,
      state: null,
      patternType: null,
      search: '',
    }));
  }, []);

  const handleRowClick = (artifact: PatlearnArtifact) => {
    setSelectedArtifact(artifact);
    setDebuggerOpen(true);
  };

  const handleRefresh = () => {
    refetchSummary();
    refetchPatterns();
  };

  return (
    <div className="space-y-6" data-testid="page-pattern-learning">
      {/* Demo mode banner */}
      <DemoBanner />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Pattern Learning</h1>
          <p className="text-muted-foreground">
            PATLEARN dashboard with evidence-based score debugging
          </p>
        </div>
        <div className="flex items-center gap-3">
          <StalenessIndicator lastUpdated={patternsLastUpdated} label="Patterns" />
          <Button variant="outline" size="sm" onClick={handleRefresh}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
        </div>
      </div>

      {/* Demo Mode Banner - shown when database is unavailable */}
      {isUsingDemoData && (
        <Alert variant="default" className="border-yellow-500/50 bg-yellow-500/10">
          <AlertCircle className="h-4 w-4 text-yellow-500" />
          <AlertTitle className="text-yellow-500">Demo Mode</AlertTitle>
          <AlertDescription className="text-muted-foreground">
            Database connection unavailable. Displaying demo data for preview purposes. The
            dashboard will automatically reconnect when the database becomes available.
          </AlertDescription>
        </Alert>
      )}

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {summaryError ? (
          <div className="col-span-full text-center py-8">
            <p className="text-destructive font-medium">Failed to load summary data</p>
            <p className="text-sm text-muted-foreground mt-1">
              {summaryErrorData instanceof Error
                ? summaryErrorData.message
                : 'Please try refreshing the page.'}
            </p>
            <Button variant="outline" size="sm" className="mt-4" onClick={() => refetchSummary()}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Retry
            </Button>
          </div>
        ) : summaryLoading ? (
          <>
            {[...Array(4)].map((_, i) => (
              <Card key={i}>
                <CardHeader className="pb-2">
                  <Skeleton className="h-4 w-24" />
                </CardHeader>
                <CardContent>
                  <Skeleton className="h-8 w-16" />
                </CardContent>
              </Card>
            ))}
          </>
        ) : (
          <>
            <StatsCard
              title="Total Patterns"
              value={summary?.totalPatterns ?? 0}
              icon={Database}
              description="Across all lifecycle states"
            />
            <StatsCard
              title="Candidates"
              value={(summary?.byState.candidate ?? 0) + (summary?.byState.provisional ?? 0)}
              icon={Clock}
              description="Pending validation"
            />
            <StatsCard
              title="Validated"
              value={summary?.byState.validated ?? 0}
              icon={CheckCircle}
              description="Confirmed learned patterns"
            />
            <StatsCard
              title="Promotions (24h)"
              value={summary?.promotionsInWindow ?? 0}
              icon={Archive}
              description="Patterns promoted to validated"
            />
          </>
        )}
      </div>

      {/* Visualization Widgets (OMN-1798) */}
      <div className="grid gap-6 md:grid-cols-2">
        <PatternStatusDistribution
          summary={summary}
          isLoading={summaryLoading}
          isError={summaryError}
          selectedState={filters.state}
          onStateClick={(state) => setFilters((prev) => ({ ...prev, state }))}
        />
        <PatternSuccessRateTrends
          patterns={filteredPatterns}
          isLoading={patternsLoading}
          isError={patternsError}
        />
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <PatternActivityTimeline
          patterns={filteredPatterns}
          isLoading={patternsLoading}
          isError={patternsError}
          onPatternClick={(patternId) => {
            const pattern = filteredPatterns.find((p) => p.id === patternId);
            if (pattern) {
              handleRowClick(pattern);
            }
          }}
        />
        <TopPatternsTable
          patterns={filteredPatterns}
          isLoading={patternsLoading}
          isError={patternsError}
          limit={5}
          onPatternClick={handleRowClick}
        />
      </div>

      {/* Filter Bar */}
      <Card className="p-4">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Filters:</span>
          </div>

          {/* State Filter */}
          <Select
            value={filters.state || 'all'}
            onValueChange={(value) =>
              setFilters((prev) => ({
                ...prev,
                state: value === 'all' ? null : (value as LifecycleState),
              }))
            }
          >
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="All States" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All States</SelectItem>
              {LIFECYCLE_STATES.map((state) => (
                <SelectItem key={state} value={state}>
                  {state.charAt(0).toUpperCase() + state.slice(1)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Pattern Type Filter */}
          <Select
            value={filters.patternType || 'all'}
            onValueChange={(value) =>
              setFilters((prev) => ({ ...prev, patternType: value === 'all' ? null : value }))
            }
          >
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="All Types" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              {availablePatternTypes.map((type) => (
                <SelectItem key={type} value={type}>
                  {type}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Search Input */}
          <div className="flex-1 max-w-xs relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search patterns..."
              aria-label="Search patterns by name, type, or language"
              value={filters.search}
              onChange={(e) => setFilters((prev) => ({ ...prev, search: e.target.value }))}
              className="h-9 pl-9 pr-8"
            />
            {isSearchPending && (
              <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground animate-spin" />
            )}
          </div>

          {/* Limit Selector */}
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Show:</span>
            <Select
              value={String(filters.limit)}
              onValueChange={(value) => setFilters((prev) => ({ ...prev, limit: Number(value) }))}
            >
              <SelectTrigger className="w-[90px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LIMIT_OPTIONS.map((option) => (
                  <SelectItem key={option} value={String(option)}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Clear Filters Button */}
          {hasActiveFilters && (
            <Button variant="ghost" size="sm" onClick={clearFilters} className="gap-1">
              <X className="h-4 w-4" />
              Clear
            </Button>
          )}

          {/* Active Filter Badges */}
          <div className="flex items-center gap-2">
            {filters.state && (
              <Badge variant="secondary" className="gap-1">
                State: {filters.state}
                <button
                  type="button"
                  aria-label={`Remove ${filters.state} state filter`}
                  className="ml-0.5 rounded-sm hover:text-destructive focus:outline-none focus:ring-1 focus:ring-ring"
                  onClick={() => setFilters((prev) => ({ ...prev, state: null }))}
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            )}
            {filters.patternType && (
              <Badge variant="secondary" className="gap-1">
                Type: {filters.patternType}
                <button
                  type="button"
                  aria-label={`Remove ${filters.patternType} pattern type filter`}
                  className="ml-0.5 rounded-sm hover:text-destructive focus:outline-none focus:ring-1 focus:ring-ring"
                  onClick={() => setFilters((prev) => ({ ...prev, patternType: null }))}
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            )}
            {filters.search && (
              <Badge variant="secondary" className="gap-1">
                Search: "{filters.search}"
                <button
                  type="button"
                  aria-label={`Remove "${filters.search}" search filter`}
                  className="ml-0.5 rounded-sm hover:text-destructive focus:outline-none focus:ring-1 focus:ring-ring"
                  onClick={() => setFilters((prev) => ({ ...prev, search: '' }))}
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            )}
          </div>
        </div>
      </Card>

      {/* Patterns Table */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Patterns</CardTitle>
              <CardDescription>
                {patternsLoading
                  ? 'Loading patterns...'
                  : `Showing ${paginatedPatterns.length}${filteredPatterns.length > paginatedPatterns.length ? ` of ${filteredPatterns.length} filtered` : ''}${patterns.length > 0 && filteredPatterns.length < patterns.length ? ` (${patterns.length} total)` : ''} patterns. Click a row to view scoring evidence.`}
              </CardDescription>
            </div>
            {hasActiveFilters &&
              patterns.length > 0 &&
              filteredPatterns.length < patterns.length && (
                <Badge variant="outline" className="text-muted-foreground">
                  {patterns.length - filteredPatterns.length} hidden by filters
                </Badge>
              )}
          </div>
        </CardHeader>
        <CardContent>
          {patternsError ? (
            <div className="text-center py-8">
              <p className="text-destructive font-medium">Failed to load patterns</p>
              <p className="text-sm text-muted-foreground mt-1">
                {patternsErrorData instanceof Error
                  ? patternsErrorData.message
                  : 'Please try refreshing the page.'}
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-4"
                onClick={() => refetchPatterns()}
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                Retry
              </Button>
            </div>
          ) : patternsLoading ? (
            <div className="space-y-2">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : paginatedPatterns.length > 0 ? (
            <Table data-testid="patterns-table">
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Language</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead className="text-right">Score</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paginatedPatterns.map((artifact) => (
                  <TableRow
                    key={artifact.id}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => handleRowClick(artifact)}
                  >
                    <TableCell className="font-medium max-w-xs" title={artifact.patternName}>
                      <span className="block truncate">{artifact.patternName}</span>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{artifact.patternType}</Badge>
                    </TableCell>
                    <TableCell>{artifact.language || '—'}</TableCell>
                    <TableCell>
                      <LifecycleStateBadge state={artifact.lifecycleState} />
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {(artifact.compositeScore * 100).toFixed(0)}%
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              {patterns.length > 0
                ? 'No patterns match the current filters.'
                : 'No patterns found.'}
            </div>
          )}

          {/* Load More Button */}
          {hasNextPage && !patternsError && (
            <div className="flex justify-center py-4 mt-4 border-t">
              <Button
                variant="outline"
                onClick={() => fetchNextPage()}
                disabled={isFetchingNextPage}
                data-testid="load-more-button"
              >
                {isFetchingNextPage ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Loading more...
                  </>
                ) : (
                  `Load More (${patterns.length} loaded)`
                )}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Score Debugger Sheet */}
      <PatternScoreDebugger
        artifact={selectedArtifact}
        open={debuggerOpen}
        onOpenChange={setDebuggerOpen}
      />
    </div>
  );
}

// ===========================
// Default Export with Error Boundary
// ===========================

export default function PatternLearning() {
  return (
    <PatternLearningErrorBoundary>
      <PatternLearningContent />
    </PatternLearningErrorBoundary>
  );
}
