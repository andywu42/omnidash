/**
 * Topic Topology Visualization Dashboard (OMN-5294)
 *
 * Renders an SVG graph of ONEX topic producers flowing into the omnidash
 * read-model consumer. Data is parsed from topics.yaml via /api/topology.
 *
 * Route: /topic-topology
 */

import { useState, useMemo, useRef, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { RefreshCw, Search, Network, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { buildApiUrl } from '@/lib/data-sources/api-base';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface TopologyNode {
  id: string;
  label: string;
  topicCount: number;
}

interface TopologyEdge {
  id: string;
  source: string;
  target: string;
  topic: string;
  handler: string;
}

interface TopologyResponse {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  totalTopics: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DASHBOARD_NODE_ID = 'omnidash';

/** Pastel palette cycled per producer node (index-stable). */
const SERVICE_COLORS = [
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#22c55e', // green
  '#f59e0b', // amber
  '#ef4444', // red
  '#06b6d4', // cyan
  '#ec4899', // pink
  '#a78bfa', // purple
  '#34d399', // emerald
  '#fb923c', // orange
];

const GRAPH_WIDTH = 800;
const GRAPH_HEIGHT = 460;
const NODE_RADIUS = 34;
const DASHBOARD_RADIUS = 46;

// ─────────────────────────────────────────────────────────────────────────────
// Layout helpers
// ─────────────────────────────────────────────────────────────────────────────

interface LayoutNode extends TopologyNode {
  x: number;
  y: number;
  color: string;
}

/**
 * Arranges producer nodes in a circle around the central dashboard node.
 */
function computeLayout(nodes: TopologyNode[]): LayoutNode[] {
  const cx = GRAPH_WIDTH / 2;
  const cy = GRAPH_HEIGHT / 2;
  const producers = nodes.filter((n) => n.id !== DASHBOARD_NODE_ID);
  const radius = Math.min(cx, cy) - NODE_RADIUS - 20;

  const result: LayoutNode[] = nodes.map((n) => {
    if (n.id === DASHBOARD_NODE_ID) {
      return { ...n, x: cx, y: cy, color: '#f1f5f9' };
    }
    return { ...n, x: 0, y: 0, color: '#ffffff' };
  });

  producers.forEach((prod, idx) => {
    const angle = (2 * Math.PI * idx) / producers.length - Math.PI / 2;
    const layoutNode = result.find((n) => n.id === prod.id);
    if (layoutNode) {
      layoutNode.x = cx + radius * Math.cos(angle);
      layoutNode.y = cy + radius * Math.sin(angle);
      layoutNode.color = SERVICE_COLORS[idx % SERVICE_COLORS.length];
    }
  });

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

interface TooltipState {
  visible: boolean;
  x: number;
  y: number;
  lines: string[];
}

interface GraphProps {
  data: TopologyResponse;
  filter: string;
}

function TopologyGraph({ data, filter }: GraphProps) {
  const [tooltip, setTooltip] = useState<TooltipState>({
    visible: false,
    x: 0,
    y: 0,
    lines: [],
  });
  const svgRef = useRef<SVGSVGElement>(null);

  const layoutNodes = useMemo(() => computeLayout(data.nodes), [data.nodes]);
  const nodeMap = useMemo(() => new Map(layoutNodes.map((n) => [n.id, n])), [layoutNodes]);

  const lowerFilter = filter.toLowerCase();

  const matchingTopics = useMemo(() => {
    if (!lowerFilter) return null;
    return new Set(
      data.edges
        .filter(
          (e) =>
            e.topic.toLowerCase().includes(lowerFilter) ||
            e.source.toLowerCase().includes(lowerFilter)
        )
        .map((e) => e.id)
    );
  }, [data.edges, lowerFilter]);

  const showEdge = useCallback(
    (edge: TopologyEdge) => {
      if (!matchingTopics) return true;
      return matchingTopics.has(edge.id);
    },
    [matchingTopics]
  );

  const showNode = useCallback(
    (nodeId: string) => {
      if (!lowerFilter) return true;
      if (nodeId === DASHBOARD_NODE_ID) return true;
      return data.edges.some(
        (e) =>
          e.source === nodeId &&
          (e.topic.toLowerCase().includes(lowerFilter) ||
            e.source.toLowerCase().includes(lowerFilter))
      );
    },
    [data.edges, lowerFilter]
  );

  const handleNodeHover = useCallback(
    (e: React.MouseEvent<SVGGElement>, nodeId: string) => {
      const svgRect = svgRef.current?.getBoundingClientRect();
      if (!svgRect) return;
      const topics = data.edges.filter((edge) => edge.source === nodeId);
      setTooltip({
        visible: true,
        x: e.clientX - svgRect.left + 12,
        y: e.clientY - svgRect.top - 8,
        lines: topics.length
          ? topics.map((t) => t.topic)
          : [nodeId === DASHBOARD_NODE_ID ? 'omnidash read-model consumer' : nodeId],
      });
    },
    [data.edges]
  );

  const handleLeave = useCallback(() => {
    setTooltip((prev) => ({ ...prev, visible: false }));
  }, []);

  return (
    <div className="relative w-full">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`}
        className="w-full h-auto"
        style={{ maxHeight: '480px' }}
      >
        {/* Edges */}
        {data.edges.map((edge) => {
          const src = nodeMap.get(edge.source);
          const tgt = nodeMap.get(edge.target);
          if (!src || !tgt) return null;
          const active = showEdge(edge);
          return (
            <line
              key={edge.id}
              x1={src.x}
              y1={src.y}
              x2={tgt.x}
              y2={tgt.y}
              stroke={active ? src.color : '#e2e8f0'}
              strokeWidth={active ? 1.5 : 0.8}
              strokeOpacity={active ? 0.7 : 0.2}
            />
          );
        })}

        {/* Nodes */}
        {layoutNodes.map((node) => {
          const visible = showNode(node.id);
          const isDash = node.id === DASHBOARD_NODE_ID;
          const r = isDash ? DASHBOARD_RADIUS : NODE_RADIUS;
          return (
            <g
              key={node.id}
              transform={`translate(${node.x}, ${node.y})`}
              onMouseMove={(e) => handleNodeHover(e, node.id)}
              onMouseLeave={handleLeave}
              style={{ cursor: 'pointer' }}
            >
              <circle
                r={r}
                fill={node.color}
                stroke={isDash ? '#94a3b8' : node.color}
                strokeWidth={isDash ? 2 : 1.5}
                opacity={visible ? 1 : 0.2}
                className="drop-shadow-sm"
              />
              <text
                textAnchor="middle"
                dominantBaseline="middle"
                fontSize={isDash ? 11 : 9}
                fontWeight={isDash ? '700' : '600'}
                fill={isDash ? '#334155' : '#1e293b'}
                opacity={visible ? 1 : 0.3}
              >
                {node.label.length > 12 ? node.label.slice(0, 11) + '…' : node.label}
              </text>
              {!isDash && (
                <text
                  textAnchor="middle"
                  dominantBaseline="middle"
                  dy="13"
                  fontSize={7.5}
                  fill="#475569"
                  opacity={visible ? 0.85 : 0.2}
                >
                  {node.topicCount} topic{node.topicCount !== 1 ? 's' : ''}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {/* Tooltip */}
      {tooltip.visible && (
        <div
          className="absolute z-10 pointer-events-none max-w-xs rounded-md border bg-popover px-2.5 py-2 text-xs shadow-md"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          {tooltip.lines.map((line, i) => (
            <div key={i} className="font-mono text-muted-foreground leading-5">
              {line}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Legend
// ─────────────────────────────────────────────────────────────────────────────

function Legend({ nodes }: { nodes: TopologyNode[] }) {
  const producers = nodes.filter((n) => n.id !== DASHBOARD_NODE_ID);
  return (
    <div className="flex flex-wrap gap-2 mt-3">
      {producers.map((node, idx) => (
        <div key={node.id} className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span
            className="inline-block h-3 w-3 rounded-full flex-shrink-0"
            style={{ background: SERVICE_COLORS[idx % SERVICE_COLORS.length] }}
          />
          {node.label}
          <Badge variant="secondary" className="text-[10px] px-1 py-0">
            {node.topicCount}
          </Badge>
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

export default function TopicTopologyDashboard() {
  const [filter, setFilter] = useState('');

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<TopologyResponse>({
    queryKey: ['topology'],
    queryFn: async () => {
      const res = await fetch(buildApiUrl('/api/topology'));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<TopologyResponse>;
    },
    staleTime: 30_000,
  });

  const filteredEdgeCount = useMemo(() => {
    if (!data || !filter) return data?.totalTopics ?? 0;
    const lower = filter.toLowerCase();
    return data.edges.filter(
      (e) => e.topic.toLowerCase().includes(lower) || e.source.toLowerCase().includes(lower)
    ).length;
  }, [data, filter]);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Topic Topology</h1>
          <p className="text-muted-foreground text-sm">
            Kafka topic producers flowing into the omnidash read-model consumer
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => refetch()}
          disabled={isFetching}
          className="gap-1.5"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* Stats row */}
      <div className="flex gap-3">
        <Card className="flex-1">
          <CardContent className="pt-4 pb-3">
            <div className="text-2xl font-bold">
              {isLoading ? <Skeleton className="h-8 w-12" /> : (data?.totalTopics ?? 0)}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">Total topics</div>
          </CardContent>
        </Card>
        <Card className="flex-1">
          <CardContent className="pt-4 pb-3">
            <div className="text-2xl font-bold">
              {isLoading ? (
                <Skeleton className="h-8 w-12" />
              ) : (
                (data?.nodes.filter((n) => n.id !== DASHBOARD_NODE_ID).length ?? 0)
              )}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">Producer services</div>
          </CardContent>
        </Card>
        {filter && (
          <Card className="flex-1">
            <CardContent className="pt-4 pb-3">
              <div className="text-2xl font-bold">{filteredEdgeCount}</div>
              <div className="text-xs text-muted-foreground mt-0.5">Matching topics</div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Graph card */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Network className="h-4 w-4" />
              Service → Dashboard Graph
            </CardTitle>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Filter by topic or service…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="pl-8 h-8 w-56 text-sm"
              />
            </div>
          </div>
          <CardDescription className="text-xs">
            Hover a node to see its topics. Filter to highlight matching edges.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading && (
            <div className="flex items-center justify-center h-64">
              <Skeleton className="h-64 w-full rounded-lg" />
            </div>
          )}
          {isError && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                Failed to load topology: {error instanceof Error ? error.message : String(error)}
              </AlertDescription>
            </Alert>
          )}
          {data && !isLoading && (
            <>
              <TopologyGraph data={data} filter={filter} />
              <Legend nodes={data.nodes} />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
