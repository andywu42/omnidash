/**
 * Platform Registry Page (OMN-2082)
 *
 * Tabbed registry showing Topics and Nodes from real Kafka events.
 * Topics tab: derived from EventBusProjection topicBreakdown (filtered, classified)
 * Nodes tab: powered by NodeRegistryProjection (no mock data fallback)
 *
 * Tab state is URL-driven via ?tab=topics or ?tab=nodes (default: topics).
 *
 * Data flow: Kafka -> EventConsumer -> ProjectionService -> REST snapshot -> Dashboard
 *            ProjectionService -> WebSocket invalidation -> re-fetch snapshot
 */

import { useCallback, useMemo, useState } from 'react';
import { useSearch, useLocation } from 'wouter';
import { DashboardRenderer } from '@/lib/widgets';
import { nodeRegistryDashboardConfig } from '@/lib/configs/node-registry-dashboard';
import { useProjectionStream } from '@/hooks/useProjectionStream';
import { DemoBanner } from '@/components/DemoBanner';
import { DetailSheet } from '@/components/DetailSheet';
import { NodeDetailContent } from '@/components/registry/NodeDetailPanel';
import { deriveNodeName } from '@/lib/node-display-utils';
import {
  transformNodeRegistryPayload,
  type NodeRegistryPayload,
  type NodeState,
} from '@/lib/data-sources/node-registry-projection-source';
import {
  transformTopicRegistryData,
  type TopicRegistryEntry,
  type TopicDomain,
} from '@/lib/data-sources/topic-registry-source';
import type { EventBusPayload } from '@shared/event-bus-payload';
import { SUFFIX_NODE_INTROSPECTION } from '@shared/topics';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  RefreshCw,
  Wifi,
  WifiOff,
  Info,
  ChevronDown,
  ChevronRight,
  Radio,
  Layers,
  Server,
  Hash,
} from 'lucide-react';

// ============================================================================
// Types
// ============================================================================

type TabId = 'topics' | 'nodes';

// ============================================================================
// Domain display config
// ============================================================================

const DOMAIN_CONFIG: Record<TopicDomain, { label: string; color: string; bgColor: string }> = {
  platform: {
    label: 'Platform',
    color: 'text-blue-400',
    bgColor: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  },
  omniclaude: {
    label: 'OmniClaude',
    color: 'text-purple-400',
    bgColor: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
  },
  agent: {
    label: 'Agent',
    color: 'text-amber-400',
    bgColor: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  },
  other: {
    label: 'Other',
    color: 'text-gray-400',
    bgColor: 'bg-gray-500/15 text-gray-400 border-gray-500/30',
  },
};

const DOMAIN_ORDER: TopicDomain[] = ['platform', 'omniclaude', 'agent', 'other'];

// ============================================================================
// Sub-components
// ============================================================================

function DomainBadge({ domain }: { domain: TopicDomain }) {
  const config = DOMAIN_CONFIG[domain];
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${config.bgColor}`}
    >
      {config.label}
    </span>
  );
}

function TopicDomainSection({
  domain,
  entries,
  defaultOpen = true,
}: {
  domain: TopicDomain;
  entries: TopicRegistryEntry[];
  defaultOpen?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const config = DOMAIN_CONFIG[domain];

  if (entries.length === 0) return null;

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger asChild>
        <button className="flex items-center gap-2 w-full py-2 px-3 rounded-md hover:bg-muted/50 transition-colors text-left">
          {isOpen ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
          <span className={`font-medium ${config.color}`}>{config.label}</span>
          <Badge variant="secondary" className="text-xs">
            {entries.length}
          </Badge>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border rounded-md overflow-hidden mt-1 mb-3">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/30">
                <th className="text-left py-2 px-3 font-medium text-muted-foreground">
                  Topic Name
                </th>
                <th className="text-right py-2 px-3 font-medium text-muted-foreground w-32">
                  Event Count
                </th>
                <th className="text-center py-2 px-3 font-medium text-muted-foreground w-28">
                  Domain
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr
                  key={entry.topic}
                  className="border-b last:border-b-0 hover:bg-muted/20 transition-colors"
                >
                  <td className="py-2 px-3 font-mono text-sm">{entry.topic}</td>
                  <td className="py-2 px-3 text-right tabular-nums">
                    {entry.eventCount.toLocaleString()}
                  </td>
                  <td className="py-2 px-3 text-center">
                    <DomainBadge domain={entry.domain} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ============================================================================
// Topics Tab
// ============================================================================

function TopicsTab({
  snapshot,
  isLoading,
}: {
  snapshot: { payload: EventBusPayload } | undefined;
  isLoading: boolean;
}) {
  const registryData = useMemo(() => {
    if (!snapshot?.payload) return null;
    return transformTopicRegistryData(snapshot.payload);
  }, [snapshot]);

  // Group entries by domain
  const groupedEntries = useMemo(() => {
    if (!registryData) return {};
    const groups: Partial<Record<TopicDomain, TopicRegistryEntry[]>> = {};
    for (const entry of registryData.entries) {
      if (!groups[entry.domain]) groups[entry.domain] = [];
      groups[entry.domain]!.push(entry);
    }
    return groups;
  }, [registryData]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="text-center space-y-3">
          <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground mx-auto" />
          <p className="text-muted-foreground">Loading topic data...</p>
        </div>
      </div>
    );
  }

  if (!registryData || registryData.entries.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-16">
          <Radio className="h-10 w-10 text-muted-foreground mb-4" />
          <h3 className="text-lg font-medium mb-2">No topics observed</h3>
          <p className="text-muted-foreground text-sm text-center max-w-md">
            Waiting for Kafka events. Topics will appear here as the EventBusProjection processes
            incoming messages from subscribed Kafka topics.
          </p>
        </CardContent>
      </Card>
    );
  }

  const { summary } = registryData;

  return (
    <div className="space-y-6">
      {/* Summary metric cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total Topics
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">{summary.totalTopics}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total Events
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">
              {summary.totalEvents.toLocaleString()}
            </div>
          </CardContent>
        </Card>

        {DOMAIN_ORDER.map((domain) => {
          const config = DOMAIN_CONFIG[domain];
          const count = summary.domainCounts[domain];
          return (
            <Card key={domain}>
              <CardHeader className="pb-2">
                <CardTitle className={`text-sm font-medium ${config.color}`}>
                  {config.label}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold tabular-nums">{count}</div>
                <p className="text-xs text-muted-foreground mt-1">
                  {count === 1 ? 'topic' : 'topics'}
                </p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Topic table grouped by domain */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Hash className="h-5 w-5" />
            Topics by Domain
          </CardTitle>
        </CardHeader>
        <CardContent>
          {DOMAIN_ORDER.map((domain) => (
            <TopicDomainSection
              key={domain}
              domain={domain}
              entries={groupedEntries[domain] ?? []}
              defaultOpen={true}
            />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

// ============================================================================
// Nodes Tab
// ============================================================================

function NodesTab({
  snapshot,
  isLoading,
}: {
  snapshot: { payload: NodeRegistryPayload } | undefined;
  isLoading: boolean;
}) {
  const [protocolOpen, setProtocolOpen] = useState(false);
  const [selectedNode, setSelectedNode] = useState<NodeState | null>(null);
  const [isPanelOpen, setIsPanelOpen] = useState(false);

  const data = snapshot?.payload ?? null;
  const hasNodes = data !== null && data.nodes.length > 0;

  const dashboardData = useMemo(() => {
    if (!data || data.nodes.length === 0) return null;
    return transformNodeRegistryPayload(data);
  }, [data]);

  const handleRowClick = useCallback(
    (_widgetId: string, row: Record<string, unknown>) => {
      if (!data) return;
      const nodeId = row.node_id as string | undefined;
      if (!nodeId) return;
      const found = data.nodes.find((n) => n.nodeId === nodeId);
      if (found) {
        setSelectedNode(found);
        setIsPanelOpen(true);
      }
    },
    [data]
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="text-center space-y-3">
          <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground mx-auto" />
          <p className="text-muted-foreground">Loading node data...</p>
        </div>
      </div>
    );
  }

  if (!hasNodes || !dashboardData) {
    return (
      <div className="space-y-6">
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <Server className="h-10 w-10 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2">No nodes registered</h3>
            <p className="text-muted-foreground text-sm text-center max-w-md">
              Waiting for registration events from Kafka. Nodes will appear here as they initiate
              the 2-way registration protocol and emit introspection events.
            </p>
          </CardContent>
        </Card>

        {/* Registration Protocol Info (collapsible, only in empty state and nodes tab) */}
        <Collapsible open={protocolOpen} onOpenChange={setProtocolOpen}>
          <div className="border rounded-lg bg-muted/50">
            <CollapsibleTrigger asChild>
              <button className="flex items-center gap-3 w-full p-4 text-left hover:bg-muted/70 transition-colors rounded-lg">
                {protocolOpen ? (
                  <ChevronDown className="h-5 w-5 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-5 w-5 text-muted-foreground" />
                )}
                <Info className="h-5 w-5 text-muted-foreground" />
                <span className="text-lg font-semibold">Node Registration Protocol</span>
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="px-4 pb-4">
                <p className="text-sm text-muted-foreground mb-4 ml-12">
                  2-way registration flow: Node initiates introspection -&gt; Registry
                  accepts/rejects -&gt; Node acknowledges -&gt; Heartbeat monitoring begins.
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 text-sm ml-12">
                  <div>
                    <span className="font-medium">Node Types:</span>
                    <div className="text-muted-foreground mt-1">
                      EFFECT, COMPUTE, REDUCER, ORCHESTRATOR
                    </div>
                  </div>
                  <div>
                    <span className="font-medium">Registration States:</span>
                    <div className="text-muted-foreground mt-1">
                      pending -&gt; accepted -&gt; awaiting_ack -&gt; active
                    </div>
                  </div>
                  <div>
                    <span className="font-medium">Failure States:</span>
                    <div className="text-muted-foreground mt-1">
                      rejected, ack_timed_out, liveness_expired
                    </div>
                  </div>
                  <div>
                    <span className="font-medium">Kafka Topics:</span>
                    <div className="text-muted-foreground mt-1">{SUFFIX_NODE_INTROSPECTION}</div>
                  </div>
                </div>
              </div>
            </CollapsibleContent>
          </div>
        </Collapsible>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Registration Protocol Info (collapsible, when nodes exist) */}
      <Collapsible open={protocolOpen} onOpenChange={setProtocolOpen}>
        <div className="border rounded-lg bg-muted/50">
          <CollapsibleTrigger asChild>
            <button className="flex items-center gap-3 w-full p-4 text-left hover:bg-muted/70 transition-colors rounded-lg">
              {protocolOpen ? (
                <ChevronDown className="h-5 w-5 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-5 w-5 text-muted-foreground" />
              )}
              <Info className="h-5 w-5 text-muted-foreground" />
              <span className="text-lg font-semibold">Node Registration Protocol</span>
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="px-4 pb-4">
              <p className="text-sm text-muted-foreground mb-4 ml-12">
                2-way registration flow: Node initiates introspection -&gt; Registry accepts/rejects
                -&gt; Node acknowledges -&gt; Heartbeat monitoring begins.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 text-sm ml-12">
                <div>
                  <span className="font-medium">Node Types:</span>
                  <div className="text-muted-foreground mt-1">
                    EFFECT, COMPUTE, REDUCER, ORCHESTRATOR
                  </div>
                </div>
                <div>
                  <span className="font-medium">Registration States:</span>
                  <div className="text-muted-foreground mt-1">
                    pending -&gt; accepted -&gt; awaiting_ack -&gt; active
                  </div>
                </div>
                <div>
                  <span className="font-medium">Failure States:</span>
                  <div className="text-muted-foreground mt-1">
                    rejected, ack_timed_out, liveness_expired
                  </div>
                </div>
                <div>
                  <span className="font-medium">Kafka Topics:</span>
                  <div className="text-muted-foreground mt-1">{SUFFIX_NODE_INTROSPECTION}</div>
                </div>
              </div>
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>

      {/* Dashboard grid */}
      <DashboardRenderer
        config={nodeRegistryDashboardConfig}
        data={dashboardData}
        isLoading={isLoading}
        onWidgetRowClick={handleRowClick}
      />

      {/* Node detail flyout */}
      <DetailSheet
        open={isPanelOpen}
        onOpenChange={setIsPanelOpen}
        title={selectedNode ? deriveNodeName(selectedNode.nodeId) : 'Node Details'}
        subtitle={selectedNode?.nodeId}
      >
        {selectedNode && <NodeDetailContent node={selectedNode} />}
      </DetailSheet>
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export default function NodeRegistry() {
  // URL-driven tab state
  const searchString = useSearch();
  const [, navigate] = useLocation();
  const params = new URLSearchParams(searchString);
  const activeTab: TabId = (params.get('tab') as TabId) || 'topics';

  const setTab = (tab: TabId) => {
    navigate(`/registry?tab=${tab}`, { replace: true });
  };

  // Topics projection (only active when Topics tab is shown)
  const topicsStream = useProjectionStream<EventBusPayload>('event-bus', undefined, {
    enabled: activeTab === 'topics',
  });

  // Nodes projection (only active when Nodes tab is shown)
  const nodesStream = useProjectionStream<NodeRegistryPayload>('node-registry', undefined, {
    enabled: activeTab === 'nodes',
  });

  // Active stream for header status display
  const activeStream = activeTab === 'topics' ? topicsStream : nodesStream;
  const { cursor, isLoading, error, isConnected, refresh } = activeStream;

  const connectionStatus = isLoading ? 'connecting' : isConnected ? 'connected' : 'disconnected';

  return (
    <div className="space-y-6">
      <DemoBanner />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Platform Registry</h1>
          <p className="text-muted-foreground">Registered nodes, topics, and platform resources</p>
        </div>

        <div className="flex items-center gap-4">
          {/* Cursor position */}
          {cursor > 0 && (
            <div className="text-sm text-muted-foreground">
              Cursor: <span className="font-mono">{cursor}</span>
            </div>
          )}

          {/* Data source badge */}
          <Badge variant="default">Live Data</Badge>

          {/* Connection status */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-2">
                <div
                  className={`h-2 w-2 rounded-full transition-colors duration-300 ${
                    isConnected
                      ? 'bg-green-500'
                      : isLoading
                        ? 'bg-yellow-500 animate-pulse'
                        : 'bg-red-500'
                  }`}
                />
                {isConnected ? (
                  <Wifi className="h-4 w-4 text-green-500" />
                ) : (
                  <WifiOff className="h-4 w-4 text-muted-foreground" />
                )}
                <span className="text-sm text-muted-foreground capitalize">{connectionStatus}</span>
              </div>
            </TooltipTrigger>
            <TooltipContent>
              <p>Projection: {connectionStatus}</p>
              {error && <p className="text-xs text-destructive">{error.message}</p>}
            </TooltipContent>
          </Tooltip>

          {/* Refresh button */}
          <Button variant="outline" size="sm" onClick={refresh} className="gap-2">
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="border-b">
        <div className="flex gap-0">
          <button
            onClick={() => setTab('topics')}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'topics'
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/30'
            }`}
          >
            <Radio className="h-4 w-4" />
            Topics
          </button>
          <button
            onClick={() => setTab('nodes')}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'nodes'
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/30'
            }`}
          >
            <Layers className="h-4 w-4" />
            Nodes
          </button>
        </div>
      </div>

      {/* Tab Content */}
      {activeTab === 'topics' ? (
        <TopicsTab snapshot={topicsStream.data} isLoading={topicsStream.isLoading} />
      ) : (
        <NodesTab snapshot={nodesStream.data} isLoading={nodesStream.isLoading} />
      )}
    </div>
  );
}
