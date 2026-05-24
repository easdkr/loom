import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  useNodesInitialized,
  useReactFlow,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import "@xyflow/react/dist/style.css";

import { useExecutionStore, useGraphStore, type GraphEdge } from "@stores/index";
import AgentFlowNode, { type AgentFlowNodeData } from "./AgentFlowNode";

const nodeTypes = { agent: AgentFlowNode };

type FlowNode = Node<AgentFlowNodeData, "agent">;

function toFlowEdge(edge: GraphEdge): Edge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: "smoothstep",
  };
}

function edgeId(connection: Connection): string {
  return `${connection.source}->${connection.target}`;
}

function GraphCanvasInner() {
  const graphNodes = useGraphStore((state) => state.nodes);
  const graphEdges = useGraphStore((state) => state.edges);
  const setNodes = useGraphStore((state) => state.setNodes);
  const setEdges = useGraphStore((state) => state.setEdges);
  const selectNode = useGraphStore((state) => state.selectNode);
  const perNode = useExecutionStore((state) => state.perNode);
  const nodesInitialized = useNodesInitialized();
  const { fitView } = useReactFlow();
  const lastFittedNodeKey = useRef("");

  const flowNodes = useMemo<FlowNode[]>(
    () =>
      graphNodes.map((node) => ({
        id: node.id,
        type: "agent",
        position: node.position,
        data: {
          type: node.type,
          meta: node.meta,
          provider: node.provider,
          prompt: node.prompt,
          skipped: node.skipped,
          status: perNode[node.id]?.status ?? "idle",
        },
      })),
    [graphNodes, perNode],
  );

  const flowEdges = useMemo(() => graphEdges.map(toFlowEdge), [graphEdges]);

  useEffect(() => {
    if (!nodesInitialized || flowNodes.length === 0) {
      return;
    }

    const nodeKey = flowNodes
      .map((node) => `${node.id}:${node.position.x}:${node.position.y}`)
      .join("|");
    if (lastFittedNodeKey.current === nodeKey) {
      return;
    }

    lastFittedNodeKey.current = nodeKey;
    requestAnimationFrame(() => {
      void fitView({ padding: 0.2, duration: 200 });
    });
  }, [fitView, flowNodes, nodesInitialized]);

  const handleNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      const next = applyNodeChanges<FlowNode>(changes, flowNodes);
      setNodes(
        next.map((flow) => {
          const existing = graphNodes.find((n) => n.id === flow.id);
          if (!existing) {
            return {
              id: flow.id,
              type: flow.data.type,
              meta: flow.data.meta,
              provider: flow.data.provider,
              prompt: flow.data.prompt,
              skipped: flow.data.skipped,
              position: flow.position,
            };
          }
          return { ...existing, position: flow.position };
        }),
      );

      for (const change of changes) {
        if (change.type === "remove") {
          selectNode(null);
        }
        if (change.type === "select" && change.selected) {
          selectNode(change.id);
        }
      }
    },
    [flowNodes, graphNodes, setNodes, selectNode],
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const next = applyEdgeChanges(changes, flowEdges);
      setEdges(
        next.map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
        })),
      );
    },
    [flowEdges, setEdges],
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target || connection.source === connection.target) {
        return;
      }
      const next = addEdge({ ...connection, id: edgeId(connection), type: "smoothstep" }, flowEdges);
      setEdges(
        next.map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
        })),
      );
    },
    [flowEdges, setEdges],
  );

  return (
    <ReactFlow
      nodes={flowNodes}
      edges={flowEdges}
      nodeTypes={nodeTypes}
      onNodesChange={handleNodesChange}
      onEdgesChange={handleEdgesChange}
      onConnect={handleConnect}
      onPaneClick={() => selectNode(null)}
      fitView
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={16} color="var(--border-subtle)" />
      <MiniMap pannable zoomable />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

function GraphCanvas() {
  return (
    <ReactFlowProvider>
      <GraphCanvasInner />
    </ReactFlowProvider>
  );
}

export default GraphCanvas;
