/**
 * Feature Flags Dashboard (OMN-5582)
 *
 * Displays all contract-declared feature flags with their current state,
 * value source, and toggle controls. Groups flags by category.
 *
 * Data source: GET /api/feature-flags (BFF proxy to registry API)
 */

import { useState, useMemo } from 'react';
import { useFeatureFlags, type FeatureFlag } from '@/hooks/useFeatureFlags';
import { DashboardPageHeader } from '@/components/DashboardPageHeader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertTriangle, Search, ToggleLeft } from 'lucide-react';

// ============================================================================
// Helpers
// ============================================================================

function ValueSourceBadge({ source }: { source: string }) {
  const variant =
    source === 'env'
      ? 'bg-blue-500/15 text-blue-400 border-blue-500/30'
      : source === 'infisical'
        ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
        : 'bg-muted text-muted-foreground';

  return (
    <Badge variant="outline" className={`text-xs font-mono ${variant}`}>
      {source}
    </Badge>
  );
}

function OwnershipBadge({ mode }: { mode: string }) {
  if (mode === 'node_owned') return null;
  return (
    <Badge variant="outline" className="text-xs text-muted-foreground/70">
      {mode.replace(/_/g, ' ')}
    </Badge>
  );
}

function ConflictBadge({ status }: { status: string }) {
  if (status === 'clean') return null;
  const isConflicted = status === 'conflicted';
  return (
    <Badge
      variant="outline"
      className={`text-xs ${
        isConflicted
          ? 'bg-red-500/15 text-red-400 border-red-500/30'
          : 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30'
      }`}
    >
      {status}
    </Badge>
  );
}

function AlignmentBadge({ alignment }: { alignment: string }) {
  if (alignment === 'aligned') return null;
  return (
    <Badge variant="outline" className="text-xs bg-amber-500/15 text-amber-400 border-amber-500/30">
      {alignment.replace(/_/g, ' ')}
    </Badge>
  );
}

// ============================================================================
// Flag Row
// ============================================================================

function FlagRow({
  flag,
  onToggle,
  isPending,
  degraded,
}: {
  flag: FeatureFlag;
  onToggle: (flagName: string, value: boolean) => void;
  isPending: boolean;
  degraded: boolean;
}) {
  const effectiveValue = flag.effective_value ?? flag.process_value;

  return (
    <div className="flex items-center justify-between gap-4 py-3 px-1 border-b border-border/50 last:border-0">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-sm font-medium">{flag.name}</span>
          {flag.env_var && (
            <Badge variant="outline" className="text-xs font-mono text-muted-foreground">
              {flag.env_var}
            </Badge>
          )}
          <ValueSourceBadge source={flag.value_source} />
          <OwnershipBadge mode={flag.ownership_mode} />
          <ConflictBadge status={flag.conflict_status} />
          <AlignmentBadge alignment={flag.state_alignment} />
        </div>
        {flag.description && (
          <p className="text-xs text-muted-foreground mt-0.5 truncate">{flag.description}</p>
        )}
        {flag.declaring_nodes_count > 0 && (
          <span className="text-xs text-muted-foreground/60">
            {flag.declaring_nodes_count} declaring node{flag.declaring_nodes_count !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      <div className="flex items-center gap-3 shrink-0">
        <Switch
          checked={effectiveValue}
          onCheckedChange={(checked) => onToggle(flag.name, checked)}
          disabled={degraded || !flag.writable || isPending}
          aria-label={`Toggle ${flag.name}`}
        />
      </div>
    </div>
  );
}

// ============================================================================
// Loading skeleton
// ============================================================================

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      {[1, 2].map((g) => (
        <Card key={g}>
          <CardHeader>
            <Skeleton className="h-5 w-32" />
          </CardHeader>
          <CardContent className="space-y-4">
            {[1, 2, 3].map((r) => (
              <div key={r} className="flex items-center justify-between">
                <div className="space-y-2">
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="h-3 w-64" />
                </div>
                <Skeleton className="h-6 w-11 rounded-full" />
              </div>
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ============================================================================
// Dashboard
// ============================================================================

export default function FeatureFlagsDashboard() {
  const [search, setSearch] = useState('');
  const {
    flags,
    degraded,
    degradedReason,
    isLoading,
    isFetching,
    refetch,
    toggleFlag,
  } = useFeatureFlags();

  // Filter flags by search
  const filtered = useMemo(() => {
    if (!search.trim()) return flags;
    const q = search.toLowerCase().trim();
    return flags.filter(
      (f) =>
        f.name.toLowerCase().includes(q) ||
        f.description.toLowerCase().includes(q) ||
        f.category.toLowerCase().includes(q) ||
        (f.env_var && f.env_var.toLowerCase().includes(q))
    );
  }, [flags, search]);

  // Group by category
  const grouped = useMemo(() => {
    const groups: Record<string, FeatureFlag[]> = {};
    for (const flag of filtered) {
      const cat = flag.category || 'uncategorized';
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(flag);
    }
    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  const pendingFlagName = toggleFlag.isPending
    ? (toggleFlag.variables as { flagName: string } | undefined)?.flagName
    : undefined;

  return (
    <div className="space-y-6">
      <DashboardPageHeader
        title="Feature Flags"
        description="Contract-declared feature flags and their runtime state"
        onRefresh={() => refetch()}
        isFetching={isFetching}
        isLoading={isLoading}
      />

      {degraded && (
        <Alert variant="default" className="border-amber-500/50 bg-amber-500/10">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          <AlertTitle className="text-amber-400">Degraded Mode</AlertTitle>
          <AlertDescription className="text-muted-foreground">
            {degradedReason || 'Registry API unavailable'}. Flag toggles are disabled.
          </AlertDescription>
        </Alert>
      )}

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search flags..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      {isLoading ? (
        <LoadingSkeleton />
      ) : flags.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <ToggleLeft className="h-12 w-12 text-muted-foreground/40 mb-4" />
            <h3 className="text-lg font-medium">No Feature Flags</h3>
            <p className="text-sm text-muted-foreground mt-1">
              No contract-declared feature flags have been registered yet.
            </p>
          </CardContent>
        </Card>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <Search className="h-12 w-12 text-muted-foreground/40 mb-4" />
            <h3 className="text-lg font-medium">No Matching Flags</h3>
            <p className="text-sm text-muted-foreground mt-1">
              No flags match &quot;{search}&quot;. Try a different search term.
            </p>
          </CardContent>
        </Card>
      ) : (
        grouped.map(([category, categoryFlags]) => (
          <Card key={category}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base capitalize">
                {category.replace(/_/g, ' ')}
                <Badge variant="secondary" className="ml-2 text-xs">
                  {categoryFlags.length}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {categoryFlags.map((flag) => (
                <FlagRow
                  key={flag.name}
                  flag={flag}
                  onToggle={(name, value) => toggleFlag.mutate({ flagName: name, value })}
                  isPending={pendingFlagName === flag.name}
                  degraded={degraded}
                />
              ))}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
