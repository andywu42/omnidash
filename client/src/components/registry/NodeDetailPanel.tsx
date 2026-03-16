/**
 * NodeDetailPanel (Node Registry)
 *
 * Inline detail panel for a selected node in the Node Registry page.
 * Replaces the status-grid-nodes widget. Displays when a table row is clicked;
 * shows an empty state prompt otherwise.
 *
 * Uses NodeState from shared/projection-types.ts as its data contract and
 * RegistrationStateBadge for state display.
 */

import { useState, useCallback } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { RegistrationStateBadge } from '@/components/registry/RegistrationStateBadge';
import { formatRelativeTime } from '@/lib/date-utils';
import { cn } from '@/lib/utils';
import type { NodeState, NodeCapabilities } from '@shared/projection-types';
import {
  Server,
  Copy,
  Check,
  Clock,
  Cpu,
  Tag,
  Globe,
  Layers,
  MousePointerClick,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Node type badge configuration (matches existing patterns)
// ---------------------------------------------------------------------------

const NODE_TYPE_COLORS: Record<string, string> = {
  EFFECT: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  COMPUTE: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  REDUCER: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  ORCHESTRATOR: 'bg-green-500/20 text-green-400 border-green-500/30',
  SERVICE: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** UUID v4 pattern: 8-4-4-4-12 hex digits */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Truncate an ID for display, keeping first and last segments visible.
 *
 * Human-readable node names (hyphenated words like "node-compute-transform-002")
 * are returned as-is. Only UUID-style identifiers are truncated to keep the
 * header compact while preserving readability.
 */
function truncateId(id: string, maxLen = 48): string {
  if (id.length <= maxLen) return id;
  // Only aggressively truncate UUIDs; show human-readable names in full
  if (UUID_RE.test(id)) {
    const half = Math.floor((maxLen - 3) / 2);
    return `${id.slice(0, half)}...${id.slice(-half)}`;
  }
  // Non-UUID long strings: use a generous limit before truncating
  if (id.length <= 64) return id;
  const half = Math.floor((64 - 3) / 2);
  return `${id.slice(0, half)}...${id.slice(-half)}`;
}

/** Format seconds into a compact human-readable duration. */
function formatUptime(seconds: number): string {
  if (seconds <= 0) return '0s';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

/** Flatten structured capabilities into a deduped string list. */
function flattenCapabilities(caps: NodeCapabilities | undefined): string[] {
  if (!caps) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const list of [caps.declared, caps.discovered, caps.contract]) {
    if (!list) continue;
    for (const c of list) {
      const lower = c.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        result.push(c);
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface NodeDetailPanelProps {
  /** The selected node, or null when nothing is selected. */
  node: NodeState | null;
  /** Additional classes on the outer Card. */
  className?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Displays detailed information about a selected node or an empty-state
 * prompt when no node is selected.
 */
export function NodeDetailPanel({ node, className }: NodeDetailPanelProps) {
  if (!node) {
    return <EmptyState className={className} />;
  }

  return <DetailView node={node} className={className} />;
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState({ className }: { className?: string }) {
  return (
    <Card className={cn('h-full flex flex-col items-center justify-center p-8', className)}>
      <MousePointerClick className="h-10 w-10 text-muted-foreground/40 mb-4" />
      <p className="text-sm font-medium text-muted-foreground">
        Select a node from the table below to view details
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Detail view
// ---------------------------------------------------------------------------

/**
 * Inner detail content without Card wrapper -- suitable for embedding in a
 * Sheet flyout or other container. Exported for use in NodeRegistry.tsx.
 */
export function NodeDetailContent({ node }: { node: NodeState }) {
  const capabilities = flattenCapabilities(node.capabilities);
  const fullDate = new Date(node.lastSeen).toLocaleString();

  return (
    <div className="space-y-4">
      {/* Primary metrics row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MetricItem label="State">
          <RegistrationStateBadge state={node.state} />
        </MetricItem>

        <MetricItem label="Version">
          <span className="font-mono text-sm">{node.version || '-'}</span>
        </MetricItem>

        <MetricItem label="Uptime">
          <span className="font-mono text-sm">{formatUptime(node.uptimeSeconds)}</span>
        </MetricItem>

        <MetricItem label="Last Seen">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-sm cursor-help">{formatRelativeTime(node.lastSeen)}</span>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p className="text-xs font-mono">{fullDate}</p>
            </TooltipContent>
          </Tooltip>
        </MetricItem>
      </div>

      {/* Resource usage (if available) */}
      {(node.cpuUsagePercent != null || node.memoryUsageMb != null) && (
        <div className="space-y-2">
          <SectionLabel icon={Cpu} label="Resources" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {node.cpuUsagePercent != null && (
              <ResourceBar label="CPU" value={node.cpuUsagePercent} unit="%" max={100} />
            )}
            {node.memoryUsageMb != null && (
              <ResourceBar label="Memory" value={node.memoryUsageMb} unit=" MB" max={2048} />
            )}
          </div>
        </div>
      )}

      {/* Capabilities */}
      {capabilities.length > 0 && (
        <div className="space-y-2">
          <SectionLabel icon={Tag} label="Capabilities" />
          <div className="flex flex-wrap gap-1.5">
            {capabilities.map((cap) => (
              <Badge key={cap} variant="outline" className="text-xs font-mono bg-muted/50">
                {cap}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {/* Metadata */}
      {node.metadata && hasMetadata(node.metadata) && (
        <div className="space-y-2">
          <SectionLabel icon={Globe} label="Metadata" />
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            {node.metadata.environment && (
              <MetadataRow label="Environment" value={node.metadata.environment} />
            )}
            {node.metadata.region && <MetadataRow label="Region" value={node.metadata.region} />}
            {node.metadata.cluster && <MetadataRow label="Cluster" value={node.metadata.cluster} />}
            {node.metadata.description && (
              <div className="col-span-2">
                <MetadataRow label="Description" value={node.metadata.description} />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Endpoints */}
      {node.endpoints && Object.keys(node.endpoints).length > 0 && (
        <div className="space-y-2">
          <SectionLabel icon={Layers} label="Endpoints" />
          <div className="grid grid-cols-1 gap-1 text-sm">
            {Object.entries(node.endpoints).map(([key, url]) => (
              <div key={key} className="flex items-center gap-2 font-mono text-xs">
                <span className="text-muted-foreground min-w-[80px]">{key}:</span>
                <span className="truncate">{url}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function DetailView({ node, className }: { node: NodeState; className?: string }) {
  return (
    <Card className={cn('h-full flex flex-col overflow-hidden', className)}>
      <CardHeader className="pb-3 space-y-0">
        <Header node={node} />
      </CardHeader>

      <CardContent className="flex-1 overflow-auto space-y-4 pt-0">
        <NodeDetailContent node={node} />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Header with node ID, type badge, and copy button
// ---------------------------------------------------------------------------

function Header({ node }: { node: NodeState }) {
  const [copied, setCopied] = useState(false);
  const typeColor =
    NODE_TYPE_COLORS[node.nodeType] ?? 'bg-gray-500/20 text-gray-400 border-gray-500/30';

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(node.nodeId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [node.nodeId]);

  return (
    <div className="flex items-center gap-3">
      <div className="flex-shrink-0 rounded-lg p-2 bg-muted/50">
        <Server className="h-5 w-5 text-muted-foreground" />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="font-mono text-sm font-medium truncate cursor-help">
                {truncateId(node.nodeId)}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-[400px]">
              <p className="text-xs font-mono break-all">{node.nodeId}</p>
            </TooltipContent>
          </Tooltip>

          <button
            onClick={handleCopy}
            className="inline-flex items-center justify-center h-6 w-6 rounded hover:bg-muted transition-colors flex-shrink-0"
            aria-label="Copy node ID"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-green-500" />
            ) : (
              <Copy className="h-3.5 w-3.5 text-muted-foreground" />
            )}
          </button>
        </div>

        <div className="flex items-center gap-2 mt-1">
          <Badge variant="outline" className={cn('text-xs', typeColor)}>
            {node.nodeType}
          </Badge>
          {node.reason && (
            <span className="text-xs text-muted-foreground">
              <Clock className="h-3 w-3 inline mr-1" />
              {node.reason}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared sub-components
// ---------------------------------------------------------------------------

function MetricItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <span className="text-xs text-muted-foreground uppercase tracking-wide">{label}</span>
      <div>{children}</div>
    </div>
  );
}

function SectionLabel({
  icon: Icon,
  label,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
      <Icon className="h-3.5 w-3.5" />
      {label}
    </div>
  );
}

function ResourceBar({
  label,
  value,
  unit,
  max,
}: {
  label: string;
  value: number;
  unit: string;
  max: number;
}) {
  const pct = Math.min(100, (value / max) * 100);
  const color = pct > 80 ? 'text-red-400' : pct > 60 ? 'text-amber-400' : 'text-green-400';

  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className={cn('font-mono', color)}>
          {value}
          {unit}
        </span>
      </div>
      <Progress value={pct} className="h-1.5" />
    </div>
  );
}

function MetadataRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </>
  );
}

function hasMetadata(m: NonNullable<NodeState['metadata']>): boolean {
  return !!(m.environment || m.region || m.cluster || m.description);
}
