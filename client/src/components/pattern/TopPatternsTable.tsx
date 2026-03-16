/**
 * TopPatternsTable
 *
 * Sortable data table showing top performing patterns.
 * Part of OMN-1798: Pattern Health Visualization Widget
 */

import { useState, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertCircle,
  Trophy,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  ExternalLink,
  Archive,
} from 'lucide-react';
import { LifecycleStateBadge } from './LifecycleStateBadge';
import type { PatlearnArtifact, LifecycleState } from '@/lib/schemas/api-response-schemas';

// ===========================
// Types
// ===========================

type SortField = 'name' | 'score' | 'usage' | 'state';
type SortDirection = 'asc' | 'desc';

interface TopPatternsTableProps {
  patterns: PatlearnArtifact[] | undefined;
  isLoading?: boolean;
  isError?: boolean;
  limit?: number;
  onPatternClick?: (pattern: PatlearnArtifact) => void;
  onDeprecate?: (pattern: PatlearnArtifact) => void;
  showActions?: boolean;
}

interface SortConfig {
  field: SortField;
  direction: SortDirection;
}

// ===========================
// Sorting Logic
// ===========================

const STATE_ORDER: Record<LifecycleState, number> = {
  validated: 0,
  provisional: 1,
  candidate: 2,
  deprecated: 3,
  requested: 4,
};

function sortPatterns(patterns: PatlearnArtifact[], config: SortConfig): PatlearnArtifact[] {
  return [...patterns].sort((a, b) => {
    let comparison = 0;

    switch (config.field) {
      case 'name':
        comparison = a.patternName.localeCompare(b.patternName);
        break;
      case 'score':
        comparison = a.compositeScore - b.compositeScore;
        break;
      case 'usage':
        const usageA = a.scoringEvidence?.frequencyFactor?.observedCount ?? 0;
        const usageB = b.scoringEvidence?.frequencyFactor?.observedCount ?? 0;
        comparison = usageA - usageB;
        break;
      case 'state':
        comparison = STATE_ORDER[a.lifecycleState] - STATE_ORDER[b.lifecycleState];
        break;
    }

    // Stable tiebreaker: equal primary values → sort by name ascending
    if (comparison === 0) {
      return a.patternName.localeCompare(b.patternName);
    }
    return config.direction === 'asc' ? comparison : -comparison;
  });
}

// ===========================
// Sortable Header
// ===========================

function SortableHeader({
  label,
  field,
  currentSort,
  onSort,
  align = 'left',
}: {
  label: string;
  field: SortField;
  currentSort: SortConfig;
  onSort: (field: SortField) => void;
  align?: 'left' | 'right';
}) {
  const isActive = currentSort.field === field;

  return (
    <TableHead className={align === 'right' ? 'text-right' : ''}>
      <button
        type="button"
        onClick={() => onSort(field)}
        className={`
          flex items-center gap-1 hover:text-foreground transition-colors
          ${align === 'right' ? 'ml-auto' : ''}
          ${isActive ? 'text-foreground' : 'text-muted-foreground'}
        `}
      >
        {label}
        {isActive ? (
          currentSort.direction === 'asc' ? (
            <ArrowUp className="h-3 w-3" />
          ) : (
            <ArrowDown className="h-3 w-3" />
          )
        ) : (
          <ArrowUpDown className="h-3 w-3 opacity-50" />
        )}
      </button>
    </TableHead>
  );
}

// ===========================
// Main Component
// ===========================

export function TopPatternsTable({
  patterns,
  isLoading = false,
  isError = false,
  limit = 10,
  onPatternClick,
  onDeprecate,
  showActions = false,
}: TopPatternsTableProps) {
  const [sortConfig, setSortConfig] = useState<SortConfig>({
    field: 'score',
    direction: 'desc',
  });

  const handleSort = (field: SortField) => {
    setSortConfig((prev) => ({
      field,
      direction: prev.field === field && prev.direction === 'desc' ? 'asc' : 'desc',
    }));
  };

  const sortedPatterns = useMemo(() => {
    if (!patterns) return [];
    const sorted = sortPatterns(patterns, sortConfig);
    return sorted.slice(0, limit);
  }, [patterns, sortConfig, limit]);

  // Loading state
  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Trophy className="h-4 w-4" />
            Top Patterns
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  // Error state
  if (isError) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Trophy className="h-4 w-4" />
            Top Patterns
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center h-[200px] text-center">
            <AlertCircle className="h-8 w-8 text-destructive mb-2" />
            <p className="text-sm text-muted-foreground">Failed to load patterns</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Empty state
  if (!sortedPatterns.length) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Trophy className="h-4 w-4" />
            Top Patterns
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center h-[200px] text-center">
            <Trophy className="h-8 w-8 text-muted-foreground mb-2 opacity-50" />
            <p className="text-sm text-muted-foreground">No patterns available</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Trophy className="h-4 w-4" />
              Top Patterns
            </CardTitle>
            <CardDescription>
              Top {sortedPatterns.length} by {sortConfig.field}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <SortableHeader
                label="Pattern"
                field="name"
                currentSort={sortConfig}
                onSort={handleSort}
              />
              <SortableHeader
                label="State"
                field="state"
                currentSort={sortConfig}
                onSort={handleSort}
              />
              <SortableHeader
                label="Score"
                field="score"
                currentSort={sortConfig}
                onSort={handleSort}
                align="right"
              />
              <SortableHeader
                label="Usage"
                field="usage"
                currentSort={sortConfig}
                onSort={handleSort}
                align="right"
              />
              {showActions && <TableHead className="w-[100px]">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedPatterns.map((pattern, index) => (
              <TableRow
                key={pattern.id}
                className={`
                  ${onPatternClick ? 'cursor-pointer hover:bg-muted/50' : ''}
                `}
                onClick={() => onPatternClick?.(pattern)}
              >
                <TableCell>
                  <div className="flex items-center gap-2">
                    {index < 3 && (
                      <span
                        className={`
                          text-xs font-bold w-5 h-5 rounded-full flex items-center justify-center
                          ${index === 0 ? 'bg-yellow-500/20 text-yellow-500' : ''}
                          ${index === 1 ? 'bg-gray-400/20 text-gray-400' : ''}
                          ${index === 2 ? 'bg-amber-600/20 text-amber-600' : ''}
                        `}
                      >
                        {index + 1}
                      </span>
                    )}
                    <div>
                      <p className="font-medium truncate max-w-[200px]">{pattern.patternName}</p>
                      <p className="text-xs text-muted-foreground">{pattern.patternType}</p>
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <LifecycleStateBadge state={pattern.lifecycleState} />
                </TableCell>
                <TableCell className="text-right font-mono">
                  <span
                    className={`
                      ${pattern.compositeScore >= 0.8 ? 'text-green-500' : ''}
                      ${pattern.compositeScore >= 0.5 && pattern.compositeScore < 0.8 ? 'text-yellow-500' : ''}
                      ${pattern.compositeScore < 0.5 ? 'text-red-500' : ''}
                    `}
                  >
                    {(pattern.compositeScore * 100).toFixed(0)}%
                  </span>
                </TableCell>
                <TableCell className="text-right font-mono">
                  {(pattern.scoringEvidence?.frequencyFactor?.observedCount ?? 0).toLocaleString()}
                </TableCell>
                {showActions && (
                  <TableCell>
                    <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => onPatternClick?.(pattern)}
                        title="View details"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </Button>
                      {pattern.lifecycleState !== 'deprecated' && onDeprecate && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-destructive"
                          onClick={() => onDeprecate(pattern)}
                          title="Deprecate pattern"
                        >
                          <Archive className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
