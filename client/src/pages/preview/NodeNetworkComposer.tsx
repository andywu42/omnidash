import React, { useMemo, useState, useRef, useCallback } from 'react';
import {
  TOPIC_OMNICLAUDE_AGENT_ACTIONS,
  TOPIC_OMNICLAUDE_ROUTING_DECISIONS,
  TOPIC_OMNICLAUDE_PERFORMANCE_METRICS,
} from '@shared/topics';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Plus,
  Trash2,
  Link as LinkIcon,
  Download,
  Play,
  CheckCircle,
  AlertTriangle,
  Network,
  Grid3X3,
  FileCode,
  Wrench,
  X,
} from 'lucide-react';

type NodeType = 'Compute' | 'Reducer' | 'Effect' | 'Orchestrator';

interface ComposerNode {
  id: string;
  name: string;
  type: NodeType;
  contract?: string;
  image?: string;
  x: number;
  y: number;
}

interface ComposerEdge {
  id: string;
  source: string;
  target: string;
  channel: string;
}

export default function NodeNetworkComposer() {
  const [nodes, setNodes] = useState<ComposerNode[]>([]);
  const [edges, setEdges] = useState<ComposerEdge[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [newNodeName, setNewNodeName] = useState('');
  const [newNodeType, setNewNodeType] = useState<NodeType>('Compute');
  const [newNodeContract, setNewNodeContract] = useState('');
  const [newNodeImage, setNewNodeImage] = useState('');

  const [linkSource, setLinkSource] = useState<string>('');
  const [linkTarget, setLinkTarget] = useState<string>('');
  const [linkChannel, setLinkChannel] = useState<string>('');

  // Drag state
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [connectingFromNodeId, setConnectingFromNodeId] = useState<string | null>(null);
  const [connectionPreview, setConnectionPreview] = useState<{ x: number; y: number } | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  const _selectedNode = useMemo(
    () => nodes.find((n) => n.id === selectedNodeId) || null,
    [nodes, selectedNodeId]
  );

  // Seed with mock data so the canvas isn't empty
  React.useEffect(() => {
    if (nodes.length === 0 && edges.length === 0) {
      const mockNodes: ComposerNode[] = [
        {
          id: 'orchestrator-root',
          name: 'root-orchestrator',
          type: 'Orchestrator',
          contract: 'onex://orchestrators/root.yaml',
          x: 300,
          y: 120,
        },
        {
          id: 'compute-ingest',
          name: 'ingest-service',
          type: 'Compute',
          image: 'ghcr.io/org/ingest:latest',
          x: 120,
          y: 300,
        },
        {
          id: 'reducer-aggregate',
          name: 'aggregate-metrics',
          type: 'Reducer',
          contract: 'onex://reducers/aggregate.yaml',
          x: 300,
          y: 300,
        },
        {
          id: 'effect-notify',
          name: 'notify-alerts',
          type: 'Effect',
          contract: 'onex://effects/notify.yaml',
          x: 480,
          y: 300,
        },
      ];
      const mockEdges: ComposerEdge[] = [
        {
          id: 'e1',
          source: 'compute-ingest',
          target: 'reducer-aggregate',
          channel: TOPIC_OMNICLAUDE_AGENT_ACTIONS,
        },
        {
          id: 'e2',
          source: 'reducer-aggregate',
          target: 'effect-notify',
          channel: TOPIC_OMNICLAUDE_PERFORMANCE_METRICS,
        },
        {
          id: 'e3',
          source: 'orchestrator-root',
          target: 'compute-ingest',
          channel: TOPIC_OMNICLAUDE_ROUTING_DECISIONS,
        },
      ];
      setNodes(mockNodes);
      setEdges(mockEdges);
    }
  }, [nodes.length, edges.length]);

  const addNode = () => {
    if (!newNodeName.trim()) return;
    const id = `${newNodeType.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`;
    const node: ComposerNode = {
      id,
      name: newNodeName.trim(),
      type: newNodeType,
      contract: newNodeContract || undefined,
      image: newNodeImage || undefined,
      x: 200 + Math.random() * 200,
      y: 200 + Math.random() * 200,
    };
    setNodes((prev) => [...prev, node]);
    setNewNodeName('');
    setNewNodeContract('');
    setNewNodeImage('');
  };

  const removeNode = (id: string) => {
    setNodes((prev) => prev.filter((n) => n.id !== id));
    setEdges((prev) => prev.filter((e) => e.source !== id && e.target !== id));
    if (selectedNodeId === id) setSelectedNodeId(null);
  };

  const addEdge = () => {
    if (!linkSource || !linkTarget || !linkChannel) return;
    const id = `edge-${Math.random().toString(36).slice(2, 8)}`;
    setEdges((prev) => [
      { id, source: linkSource, target: linkTarget, channel: linkChannel },
      ...prev,
    ]);
    setLinkSource('');
    setLinkTarget('');
    setLinkChannel('');
  };

  const removeEdge = (id: string) => {
    setEdges((prev) => prev.filter((e) => e.id !== id));
  };

  // Handle node dragging
  const handleNodeMouseDown = useCallback(
    (e: React.MouseEvent, nodeId: string) => {
      e.stopPropagation();
      const node = nodes.find((n) => n.id === nodeId);
      if (!node) return;

      setDraggingNodeId(nodeId);
      setDragOffset({
        x: e.clientX - node.x,
        y: e.clientY - node.y,
      });
      setSelectedNodeId(nodeId);
    },
    [nodes]
  );

  const handleNodeMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!draggingNodeId) return;

      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;

      const newX = e.clientX - rect.left - dragOffset.x;
      const newY = e.clientY - rect.top - dragOffset.y;

      setNodes((prev) =>
        prev.map((node) =>
          node.id === draggingNodeId
            ? {
                ...node,
                x: Math.max(50, Math.min(rect.width - 50, newX)),
                y: Math.max(50, Math.min(rect.height - 50, newY)),
              }
            : node
        )
      );
    },
    [draggingNodeId, dragOffset]
  );

  const handleNodeMouseUp = useCallback(
    (targetNodeId?: string) => {
      // If we're connecting and we have a target node, complete the connection
      if (connectingFromNodeId && targetNodeId && connectingFromNodeId !== targetNodeId) {
        const channel = prompt('Enter channel/topic name (e.g., agent-actions):');
        if (channel && channel.trim()) {
          const id = `edge-${Math.random().toString(36).slice(2, 8)}`;
          setEdges((prev) => [
            { id, source: connectingFromNodeId, target: targetNodeId, channel: channel.trim() },
            ...prev,
          ]);
        }
        setConnectingFromNodeId(null);
        setConnectionPreview(null);
      }
      setDraggingNodeId(null);
    },
    [connectingFromNodeId]
  );

  // Handle connection creation via click-and-drag
  const handleConnectionStart = useCallback(
    (e: React.MouseEvent, nodeId: string) => {
      e.stopPropagation();
      setConnectingFromNodeId(nodeId);

      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;

      const node = nodes.find((n) => n.id === nodeId);
      if (!node) return;

      setConnectionPreview({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    },
    [nodes]
  );

  const handleConnectionMove = useCallback(
    (e: React.MouseEvent) => {
      if (!connectingFromNodeId) return;

      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;

      setConnectionPreview({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    },
    [connectingFromNodeId]
  );

  // Calculate connection line endpoints
  const getNodeCenter = (nodeId: string): { x: number; y: number } => {
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return { x: 0, y: 0 };
    return { x: node.x, y: node.y };
  };

  const validation = useMemo(() => {
    const problems: string[] = [];
    const nodeIds = new Set(nodes.map((n) => n.id));

    const hasReducer = nodes.some((n) => n.type === 'Reducer');
    const hasOrchestrator = nodes.some((n) => n.type === 'Orchestrator');
    if (hasReducer && !hasOrchestrator) {
      problems.push('Reducers present but no Orchestrator node found.');
    }

    edges.forEach((e) => {
      if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) {
        problems.push(`Edge ${e.id} references missing nodes.`);
      }
      if (e.source === e.target) {
        problems.push(`Edge ${e.id} loops to the same node.`);
      }
    });

    nodes.forEach((n) => {
      if ((n.type === 'Effect' || n.type === 'Orchestrator') && !n.contract) {
        problems.push(`${n.name} (${n.type}) has no contract assigned.`);
      }
    });

    return { ok: problems.length === 0, problems };
  }, [nodes, edges]);

  const yamlExport = useMemo(() => {
    const doc = {
      version: '2.0',
      network: {
        nodes: nodes.map((n) => ({
          id: n.id,
          name: n.name,
          type: n.type,
          contract: n.contract,
          image: n.image,
        })),
        edges: edges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          channel: e.channel,
        })),
      },
    };
    return JSON.stringify(doc, null, 2);
  }, [nodes, edges]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Node Network Composer</h1>
          <p className="text-muted-foreground">
            Design full ONEX node networks with drag-and-drop and visual connections.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm">
            <Wrench className="w-4 h-4 mr-2" />
            Configure
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigator.clipboard.writeText(yamlExport)}
          >
            <FileCode className="w-4 h-4 mr-2" />
            Copy YAML
          </Button>
          <Button variant="outline" size="sm">
            <Download className="w-4 h-4 mr-2" />
            Export
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Grid3X3 className="w-5 h-5" />
              Node Palette
            </CardTitle>
            <CardDescription>Add nodes and configure core fields.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="node-name">Name</Label>
              <Input
                id="node-name"
                value={newNodeName}
                onChange={(e) => setNewNodeName(e.target.value)}
                placeholder="e.g. auth-service"
              />
            </div>
            <div className="space-y-2">
              <Label>Type</Label>
              <Select value={newNodeType} onValueChange={(v: any) => setNewNodeType(v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Compute">Compute</SelectItem>
                  <SelectItem value="Reducer">Reducer</SelectItem>
                  <SelectItem value="Effect">Effect</SelectItem>
                  <SelectItem value="Orchestrator">Orchestrator</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="node-contract">Contract (optional)</Label>
              <Input
                id="node-contract"
                value={newNodeContract}
                onChange={(e) => setNewNodeContract(e.target.value)}
                placeholder="e.g. onex://contracts/auth.yaml"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="node-image">Image (optional)</Label>
              <Input
                id="node-image"
                value={newNodeImage}
                onChange={(e) => setNewNodeImage(e.target.value)}
                placeholder="e.g. ghcr.io/org/service:tag"
              />
            </div>
            <Button onClick={addNode} className="w-full">
              <Plus className="w-4 h-4 mr-2" />
              Add Node
            </Button>

            <Separator className="my-2" />

            <div className="space-y-2">
              <Label>Connect Nodes (Text Entry)</Label>
              <Select value={linkSource} onValueChange={setLinkSource}>
                <SelectTrigger>
                  <SelectValue placeholder="Source node" />
                </SelectTrigger>
                <SelectContent>
                  {nodes.map((n) => (
                    <SelectItem key={n.id} value={n.id}>
                      {n.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={linkTarget} onValueChange={setLinkTarget}>
                <SelectTrigger>
                  <SelectValue placeholder="Target node" />
                </SelectTrigger>
                <SelectContent>
                  {nodes.map((n) => (
                    <SelectItem key={n.id} value={n.id}>
                      {n.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                value={linkChannel}
                onChange={(e) => setLinkChannel(e.target.value)}
                placeholder="channel/topic (e.g. agent-actions)"
              />
              <Button variant="outline" onClick={addEdge} className="w-full">
                <LinkIcon className="w-4 h-4 mr-2" />
                Add Connection
              </Button>
              <p className="text-xs text-muted-foreground">
                Or drag from a node's connection point to create a connection visually.
              </p>
            </div>
          </CardContent>
        </Card>

        <div className="lg:col-span-3 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Network className="w-5 h-5" />
                Canvas
              </CardTitle>
              <CardDescription>
                Drag nodes to reposition. Click and drag from a node's edge to connect nodes.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div
                ref={canvasRef}
                className="relative border-2 border-dashed rounded-lg bg-muted/30"
                style={{ minHeight: '600px', width: '100%' }}
                onMouseMove={(e) => {
                  handleNodeMouseMove(e);
                  handleConnectionMove(e);
                }}
                onMouseUp={() => {
                  // If we're connecting but not over a node, cancel the connection
                  if (connectingFromNodeId) {
                    setConnectingFromNodeId(null);
                    setConnectionPreview(null);
                  }
                  handleNodeMouseUp();
                }}
                onMouseLeave={() => {
                  setDraggingNodeId(null);
                  setConnectingFromNodeId(null);
                  setConnectionPreview(null);
                }}
              >
                {/* SVG overlay for connections */}
                <svg
                  className="absolute inset-0 pointer-events-none"
                  style={{ width: '100%', height: '100%' }}
                >
                  {/* Draw existing connections */}
                  {edges.map((edge) => {
                    const source = getNodeCenter(edge.source);
                    const target = getNodeCenter(edge.target);
                    return (
                      <g key={edge.id}>
                        <line
                          x1={source.x}
                          y1={source.y}
                          x2={target.x}
                          y2={target.y}
                          stroke="hsl(var(--primary))"
                          strokeWidth="2"
                          markerEnd="url(#arrowhead)"
                        />
                        <text
                          x={(source.x + target.x) / 2}
                          y={(source.y + target.y) / 2 - 5}
                          className="text-xs fill-foreground font-mono"
                          textAnchor="middle"
                          pointerEvents="none"
                        >
                          {edge.channel}
                        </text>
                      </g>
                    );
                  })}

                  {/* Draw connection preview */}
                  {connectingFromNodeId && connectionPreview && (
                    <line
                      x1={getNodeCenter(connectingFromNodeId).x}
                      y1={getNodeCenter(connectingFromNodeId).y}
                      x2={connectionPreview.x}
                      y2={connectionPreview.y}
                      stroke="hsl(var(--primary))"
                      strokeWidth="2"
                      strokeDasharray="5,5"
                      opacity="0.5"
                    />
                  )}

                  {/* Arrow marker */}
                  <defs>
                    <marker
                      id="arrowhead"
                      markerWidth="10"
                      markerHeight="10"
                      refX="9"
                      refY="3"
                      orient="auto"
                    >
                      <polygon points="0 0, 10 3, 0 6" fill="hsl(var(--primary))" />
                    </marker>
                  </defs>
                </svg>

                {/* Render nodes */}
                {nodes.map((node) => (
                  <div
                    key={node.id}
                    className={`absolute cursor-move border-2 rounded-lg p-3 bg-background shadow-lg transition-shadow ${
                      selectedNodeId === node.id
                        ? 'ring-2 ring-primary border-primary'
                        : 'border-border hover:border-primary/50'
                    } ${draggingNodeId === node.id ? 'z-50' : 'z-10'}`}
                    style={{
                      left: `${node.x}px`,
                      top: `${node.y}px`,
                      transform: 'translate(-50%, -50%)',
                      minWidth: '150px',
                    }}
                    onMouseDown={(e) => handleNodeMouseDown(e, node.id)}
                    onMouseUp={(e) => {
                      e.stopPropagation();
                      handleNodeMouseUp(node.id);
                    }}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="font-medium text-sm">{node.name}</div>
                      <Badge variant="secondary" className="text-xs">
                        {node.type}
                      </Badge>
                    </div>
                    {node.contract && (
                      <div
                        className="text-xs text-muted-foreground truncate mb-1"
                        title={node.contract}
                      >
                        {node.contract}
                      </div>
                    )}
                    {node.image && (
                      <div
                        className="text-xs text-muted-foreground truncate mb-1"
                        title={node.image}
                      >
                        {node.image}
                      </div>
                    )}
                    <div className="flex items-center justify-between mt-2 pt-2 border-t">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 text-xs"
                        onMouseDown={(e) => handleConnectionStart(e, node.id)}
                        title="Drag to connect to another node"
                      >
                        <LinkIcon className="w-3 h-3" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 w-6 p-0"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeNode(node.id);
                        }}
                      >
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>
                ))}

                {nodes.length === 0 && (
                  <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
                    <div className="text-center">
                      <Network className="w-12 h-12 mx-auto mb-2 opacity-50" />
                      <p>No nodes yet. Use the palette to add nodes.</p>
                      <p className="text-sm mt-1">Drag nodes to reposition them.</p>
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            <Card>
              <CardHeader>
                <CardTitle>Connections</CardTitle>
                <CardDescription>Edges between nodes with channels/topics.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {edges.map((e) => (
                    <div
                      key={e.id}
                      className="border rounded p-2 text-sm flex items-center justify-between"
                    >
                      <div>
                        <span className="font-semibold">
                          {nodes.find((n) => n.id === e.source)?.name || e.source}
                        </span>
                        <span className="mx-2 text-muted-foreground">→</span>
                        <span className="font-semibold">
                          {nodes.find((n) => n.id === e.target)?.name || e.target}
                        </span>
                        <span className="mx-2 text-muted-foreground">on</span>
                        <span className="font-mono">{e.channel}</span>
                      </div>
                      <Button size="sm" variant="ghost" onClick={() => removeEdge(e.id)}>
                        <X className="w-4 h-4" />
                      </Button>
                    </div>
                  ))}
                  {edges.length === 0 && (
                    <div className="text-sm text-muted-foreground">No connections yet.</div>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>YAML Preview</CardTitle>
                <CardDescription>Exportable network configuration.</CardDescription>
              </CardHeader>
              <CardContent>
                <pre className="bg-muted p-3 rounded text-xs overflow-auto max-h-64">
                  {yamlExport || 'Add nodes to see YAML preview'}
                </pre>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {validation.ok ? (
                  <CheckCircle className="w-5 h-5 text-green-600" />
                ) : (
                  <AlertTriangle className="w-5 h-5 text-yellow-600" />
                )}
                Validation
              </CardTitle>
              <CardDescription>Quick checks for obvious configuration issues.</CardDescription>
            </CardHeader>
            <CardContent>
              {validation.ok ? (
                <Alert>
                  <AlertDescription>Looks good! No issues found.</AlertDescription>
                </Alert>
              ) : (
                <div className="space-y-2">
                  {validation.problems.map((p, i) => (
                    <Alert key={i}>
                      <AlertDescription>{p}</AlertDescription>
                    </Alert>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <div className="flex gap-2 justify-end">
            <Button>
              <Play className="w-4 h-4 mr-2" />
              Simulate
            </Button>
            <Button variant="outline" onClick={() => navigator.clipboard.writeText(yamlExport)}>
              <FileCode className="w-4 h-4 mr-2" />
              Copy YAML
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
