/**
 * NodeDetailPanel Component
 *
 * A slide-out panel showing detailed information about a selected node.
 * Displays node metadata, capabilities, contract summary, and live instances.
 *
 * Part of OMN-1278: Contract-Driven Dashboard - Registry Discovery (Phase 5)
 */

import { useMemo } from 'react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { formatRelativeTime } from '@/lib/date-utils';
import { normalizeHealthStatus, type SemanticHealthLevel } from '@/lib/health-utils';
import {
  Zap,
  Cpu,
  Layers,
  Network,
  Clock,
  Server,
  Activity,
  CheckCircle,
  AlertCircle,
  AlertTriangle,
  HelpCircle,
  FileCode,
  GitBranch,
  type LucideIcon,
} from 'lucide-react';
import type {
  RegisteredNodeInfo,
  LiveInstanceInfo,
  NodeType,
  NodeState,
  HealthStatus as _HealthStatus,
} from '@/lib/configs/registry-discovery-dashboard';

// Node type icons and colors
export const NODE_TYPE_CONFIG: Record<
  NodeType,
  { icon: LucideIcon; label: string; color: string; bgColor: string }
> = {
  EFFECT: {
    icon: Zap,
    label: 'Effect Node',
    color: 'text-purple-500',
    bgColor: 'bg-purple-500/10',
  },
  COMPUTE: {
    icon: Cpu,
    label: 'Compute Node',
    color: 'text-blue-500',
    bgColor: 'bg-blue-500/10',
  },
  REDUCER: {
    icon: Layers,
    label: 'Reducer Node',
    color: 'text-amber-500',
    bgColor: 'bg-amber-500/10',
  },
  ORCHESTRATOR: {
    icon: Network,
    label: 'Orchestrator Node',
    color: 'text-green-500',
    bgColor: 'bg-green-500/10',
  },
  SERVICE: {
    icon: Server,
    label: 'Service Node',
    color: 'text-cyan-500',
    bgColor: 'bg-cyan-500/10',
  },
};

// State badge configurations - matches RegistrationState from ONEX state machine
export const NODE_STATE_CONFIG: Record<
  NodeState,
  { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline'; className: string }
> = {
  PENDING_REGISTRATION: {
    label: 'Pending',
    variant: 'outline',
    className: 'bg-yellow-500/10 text-yellow-600 border-yellow-300',
  },
  ACCEPTED: {
    label: 'Accepted',
    variant: 'secondary',
    className: 'bg-blue-500/10 text-blue-600 border-blue-300',
  },
  AWAITING_ACK: {
    label: 'Awaiting ACK',
    variant: 'outline',
    className: 'bg-yellow-500/10 text-yellow-600 border-yellow-300',
  },
  ACK_RECEIVED: {
    label: 'ACK Received',
    variant: 'secondary',
    className: 'bg-blue-500/10 text-blue-600 border-blue-300',
  },
  ACTIVE: {
    label: 'Active',
    variant: 'default',
    className: 'bg-green-500/10 text-green-600 border-green-300',
  },
  ACK_TIMED_OUT: {
    label: 'ACK Timeout',
    variant: 'destructive',
    className: 'bg-orange-500/10 text-orange-600 border-orange-300',
  },
  LIVENESS_EXPIRED: {
    label: 'Expired',
    variant: 'destructive',
    className: 'bg-red-500/10 text-red-600 border-red-300',
  },
  REJECTED: {
    label: 'Rejected',
    variant: 'destructive',
    className: 'bg-red-500/10 text-red-600 border-red-300',
  },
};

// Health status configurations using semantic health levels
// This config uses SemanticHealthLevel from health-utils for consistency
export const HEALTH_STATUS_CONFIG: Record<
  SemanticHealthLevel,
  { icon: LucideIcon; label: string; color: string; bgColor: string }
> = {
  healthy: {
    icon: CheckCircle,
    label: 'Healthy',
    color: 'text-green-500',
    bgColor: 'bg-green-500/10',
  },
  warning: {
    icon: AlertTriangle,
    label: 'Warning',
    color: 'text-yellow-500',
    bgColor: 'bg-yellow-500/10',
  },
  critical: {
    icon: AlertCircle,
    label: 'Critical',
    color: 'text-red-500',
    bgColor: 'bg-red-500/10',
  },
  unknown: {
    icon: HelpCircle,
    label: 'Unknown',
    color: 'text-gray-500',
    bgColor: 'bg-gray-500/10',
  },
};

/**
 * Get health status config for any health status string.
 * Normalizes the input using health-utils before looking up the config.
 */
export function getHealthConfig(status: string | null | undefined) {
  const normalized = normalizeHealthStatus(status);
  return HEALTH_STATUS_CONFIG[normalized];
}

export interface NodeDetailPanelProps {
  /**
   * The node to display details for
   */
  node: RegisteredNodeInfo | null;

  /**
   * Live instances for this node
   */
  instances?: LiveInstanceInfo[];

  /**
   * Whether the panel is open
   */
  open: boolean;

  /**
   * Callback when the panel should close
   */
  onClose: () => void;
}

/**
 * NodeDetailPanel displays comprehensive information about a selected node.
 *
 * @example
 * ```tsx
 * <NodeDetailPanel
 *   node={selectedNode}
 *   instances={nodeInstances}
 *   open={isPanelOpen}
 *   onClose={() => setIsPanelOpen(false)}
 * />
 * ```
 */
export function NodeDetailPanel({ node, instances = [], open, onClose }: NodeDetailPanelProps) {
  // Capabilities are now an array from the API
  const capabilities = useMemo(() => {
    if (!node?.capabilities) return [];
    return node.capabilities.filter(Boolean);
  }, [node?.capabilities]);

  // Get matching instances for this node
  const nodeInstances = useMemo(() => {
    if (!node) return [];
    // Match by converting node name to service name format
    const serviceName = node.name
      .replace(/([A-Z])/g, '-$1')
      .toLowerCase()
      .replace(/^-/, '');
    return instances.filter(
      (inst) =>
        inst.service_name.toLowerCase().includes(serviceName) ||
        inst.service_name.toLowerCase().includes(node.name.toLowerCase())
    );
  }, [node, instances]);

  // Infer contract details from node type
  const contractSummary = useMemo(() => {
    if (!node) return null;

    const typeDetails: Record<NodeType, { intents: string[]; protocols: string[] }> = {
      EFFECT: {
        intents: ['External I/O', 'Side Effects', 'State Mutations'],
        protocols: ['Async/Await', 'Event-Driven', 'Retry Policy'],
      },
      COMPUTE: {
        intents: ['Pure Computation', 'Data Transform', 'Algorithm Execution'],
        protocols: ['Functional', 'Stateless', 'Deterministic'],
      },
      REDUCER: {
        intents: ['Aggregation', 'State Reduction', 'Data Merge'],
        protocols: ['Accumulator Pattern', 'Idempotent', 'Order-Independent'],
      },
      ORCHESTRATOR: {
        intents: ['Workflow Control', 'Task Coordination', 'Dependency Resolution'],
        protocols: ['DAG Execution', 'Parallel Dispatch', 'Error Handling'],
      },
      SERVICE: {
        intents: ['Long-Running Service', 'API Endpoint', 'Real-Time Processing'],
        protocols: ['HTTP/REST', 'WebSocket', 'Event Streaming'],
      },
    };

    return typeDetails[node.node_type];
  }, [node]);

  if (!node) return null;

  const typeConfig = NODE_TYPE_CONFIG[node.node_type];
  const stateConfig = NODE_STATE_CONFIG[node.state];
  const TypeIcon = typeConfig.icon;

  return (
    <Sheet open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <SheetContent className="w-full sm:max-w-lg overflow-hidden flex flex-col">
        <SheetHeader className="flex-shrink-0">
          {/* Node header with type icon */}
          <div className="flex items-start gap-3">
            <div className={cn('rounded-lg p-2.5', typeConfig.bgColor)}>
              <TypeIcon className={cn('h-6 w-6', typeConfig.color)} />
            </div>
            <div className="flex-1 min-w-0">
              <SheetTitle className="text-lg font-semibold truncate">{node.name}</SheetTitle>
              <SheetDescription className="flex items-center gap-2 mt-1">
                <span className={cn('text-xs font-medium', typeConfig.color)}>
                  {typeConfig.label}
                </span>
                <span className="text-muted-foreground">v{node.version}</span>
              </SheetDescription>
            </div>
          </div>

          {/* State badge */}
          <div className="flex items-center gap-2 mt-3">
            <Badge variant={stateConfig.variant} className={stateConfig.className}>
              {stateConfig.label}
            </Badge>
            {node.registered_at && (
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <Clock className="h-3 w-3" />
                Registered {formatRelativeTime(node.registered_at)}
              </span>
            )}
          </div>
        </SheetHeader>

        <Separator className="my-4" />

        <ScrollArea className="flex-1 -mx-6 px-6">
          <div className="space-y-6 pb-6">
            {/* Description */}
            {node.description && (
              <div>
                <h4 className="text-sm font-medium mb-2">Description</h4>
                <p className="text-sm text-muted-foreground">{node.description}</p>
              </div>
            )}

            {/* Capabilities */}
            <div>
              <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                <FileCode className="h-4 w-4" />
                Capabilities
              </h4>
              {capabilities.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {capabilities.map((cap: string, idx: number) => (
                    <Badge key={idx} variant="outline" className="text-xs font-mono bg-muted/50">
                      {cap}
                    </Badge>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground italic">No capabilities defined</p>
              )}
            </div>

            {/* Contract Summary */}
            {contractSummary && (
              <div>
                <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                  <GitBranch className="h-4 w-4" />
                  Contract Summary
                </h4>
                <div className="space-y-3">
                  <div>
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                      Intent Types
                    </span>
                    <div className="flex flex-wrap gap-1.5 mt-1">
                      {contractSummary.intents.map((intent, idx) => (
                        <Badge key={idx} variant="secondary" className="text-xs">
                          {intent}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  <div>
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                      Protocols
                    </span>
                    <div className="flex flex-wrap gap-1.5 mt-1">
                      {contractSummary.protocols.map((protocol, idx) => (
                        <Badge key={idx} variant="outline" className="text-xs">
                          {protocol}
                        </Badge>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Live Instances */}
            <div>
              <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                <Server className="h-4 w-4" />
                Live Instances
                <Badge variant="secondary" className="text-xs ml-auto">
                  {nodeInstances.length}
                </Badge>
              </h4>
              {nodeInstances.length > 0 ? (
                <div className="space-y-2">
                  {nodeInstances.map((instance, idx) => {
                    // Normalize health status using centralized utility
                    const healthConfig = getHealthConfig(instance.health_status);
                    const HealthIcon = healthConfig.icon;

                    return (
                      <div
                        key={idx}
                        className={cn('p-3 rounded-lg border bg-card', healthConfig.bgColor)}
                      >
                        <div className="flex items-center justify-between mb-2">
                          <span className="font-mono text-sm">
                            {instance.address}:{instance.port}
                          </span>
                          <div className="flex items-center gap-1.5">
                            <HealthIcon className={cn('h-4 w-4', healthConfig.color)} />
                            <span className={cn('text-xs font-medium', healthConfig.color)}>
                              {healthConfig.label}
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Activity className="h-3 w-3" />
                          Last check: {formatRelativeTime(instance.last_check_at)}
                        </div>
                        {instance.tags && instance.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-2">
                            {instance.tags.map((tag, tagIdx) => (
                              <Badge key={tagIdx} variant="outline" className="text-xs py-0">
                                {tag}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="p-4 rounded-lg border border-dashed bg-muted/30 text-center">
                  <Server className="h-8 w-8 mx-auto mb-2 text-muted-foreground opacity-50" />
                  <p className="text-sm text-muted-foreground">No live instances found</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Instances will appear when the node is deployed
                  </p>
                </div>
              )}
            </div>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

/**
 * NodeTypeIcon - Reusable node type icon component
 */
export function NodeTypeIcon({
  type,
  size = 'default',
  showLabel = false,
  className,
}: {
  type: NodeType;
  size?: 'sm' | 'default' | 'lg';
  showLabel?: boolean;
  className?: string;
}) {
  const config = NODE_TYPE_CONFIG[type];
  const Icon = config.icon;

  const sizeClasses = {
    sm: 'h-3.5 w-3.5',
    default: 'h-4 w-4',
    lg: 'h-5 w-5',
  };

  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <span className={cn('rounded p-0.5', config.bgColor)}>
        <Icon className={cn(sizeClasses[size], config.color)} />
      </span>
      {showLabel && <span className={cn('text-xs font-medium', config.color)}>{type}</span>}
    </span>
  );
}

/**
 * NodeStateBadge - Reusable state badge component
 */
export function NodeStateBadge({ state, className }: { state: NodeState; className?: string }) {
  const config = NODE_STATE_CONFIG[state];

  return (
    <Badge variant={config.variant} className={cn(config.className, className)}>
      {config.label}
    </Badge>
  );
}

/**
 * HealthStatusBadge - Reusable health status badge component
 * Accepts any health status string and normalizes it using the centralized utility.
 */
export function HealthStatusBadge({
  status,
  showIcon = true,
  className,
}: {
  status: string;
  showIcon?: boolean;
  className?: string;
}) {
  // Normalize any health status string to semantic level
  const config = getHealthConfig(status);
  const Icon = config.icon;

  return (
    <Badge variant="outline" className={cn(config.bgColor, 'border-transparent gap-1', className)}>
      {showIcon && <Icon className={cn('h-3 w-3', config.color)} />}
      <span className={config.color}>{config.label}</span>
    </Badge>
  );
}

export default NodeDetailPanel;
