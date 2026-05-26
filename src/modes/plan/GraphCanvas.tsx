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
  useReactFlow,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import "@xyflow/react/dist/style.css";

import { useExecutionStore, useGraphStore, type GraphEdge } from "@stores/index";
import { Button } from "@design/components";
import AgentFlowNode, { type AgentFlowNodeData } from "./AgentFlowNode";
import { PALETTE, type PaletteEntry } from "./node-catalog";

const nodeTypes = { agent: AgentFlowNode };

type FlowNode = Node<AgentFlowNodeData, "agent">;

let quickNodeCounter = 0;

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

function nodeId(type: string): string {
  quickNodeCounter += 1;
  const slug = type.replace(/[^a-z0-9]/gi, "-").toLowerCase();
  return `${slug}-${Date.now().toString(36)}-${quickNodeCounter}`;
}

function GraphCanvasInner() {
  const graphNodes = useGraphStore((state) => state.nodes);
  const graphEdges = useGraphStore((state) => state.edges);
  const setNodes = useGraphStore((state) => state.setNodes);
  const setEdges = useGraphStore((state) => state.setEdges);
  const upsertNode = useGraphStore((state) => state.upsertNode);
  const selectNode = useGraphStore((state) => state.selectNode);
  const perNode = useExecutionStore((state) => state.perNode);
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
    if (flowNodes.length === 0) {
      return;
    }

    const nodeKey = flowNodes
      .map((node) => `${node.id}:${node.position.x}:${node.position.y}`)
      .join("|");
    if (lastFittedNodeKey.current === nodeKey) {
      return;
    }

    lastFittedNodeKey.current = nodeKey;
    const fit = () => {
      void fitView({ padding: 0.2, duration: 200 });
    };
    requestAnimationFrame(fit);
    const retry = window.setTimeout(fit, 250);
    return () => window.clearTimeout(retry);
  }, [fitView, flowNodes]);

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

  const addNode = useCallback(
    (entry: PaletteEntry, index = graphNodes.length) => {
      const id = nodeId(entry.type);
      upsertNode({
        id,
        type: entry.type,
        meta: { ...entry.meta },
        provider: entry.defaultProvider,
        prompt: entry.defaultPrompt,
        position: {
          x: 80 + (index % 3) * 320,
          y: 80 + Math.floor(index / 3) * 220,
        },
      });
      selectNode(id);
    },
    [graphNodes.length, selectNode, upsertNode],
  );

  const addStarterGraph = useCallback(() => {
    const starterTypes = ["worker:pty", "reviewer:llm", "worker:shell"];
    const entries = starterTypes
      .map((type) => PALETTE.find((entry) => entry.type === type))
      .filter((entry): entry is PaletteEntry => Boolean(entry));
    const nodes = entries.map((entry, index) => ({
      id: nodeId(entry.type),
      type: entry.type,
      meta: { ...entry.meta },
      provider: entry.defaultProvider,
      prompt: entry.defaultPrompt,
      position: {
        x: 80 + index * 320,
        y: 120,
      },
    }));
    setNodes(nodes);
    setEdges(
      nodes.slice(1).map((node, index) => ({
        id: `${nodes[index].id}->${node.id}`,
        source: nodes[index].id,
        target: node.id,
      })),
    );
    selectNode(nodes[0]?.id ?? null);
  }, [selectNode, setEdges, setNodes]);

  const reflowGraph = useCallback(() => {
    setNodes(
      graphNodes.map((node, index) => ({
        ...node,
        position: {
          x: 80 + (index % 3) * 320,
          y: 120 + Math.floor(index / 3) * 220,
        },
      })),
    );
    selectNode(graphNodes[0]?.id ?? null);
    window.setTimeout(() => {
      void fitView({ padding: 0.2, duration: 200 });
    }, 0);
  }, [fitView, graphNodes, selectNode, setNodes]);

  const fitGraph = useCallback(() => {
    void fitView({ padding: 0.2, duration: 200 });
  }, [fitView]);

  return (
    <div className="plan-graph-surface">
      <div className="plan-graph-toolbar">
        <span className="plan-graph-count">
          {graphNodes.length} node{graphNodes.length === 1 ? "" : "s"} · {graphEdges.length} edge
          {graphEdges.length === 1 ? "" : "s"}
        </span>
        <Button variant="ghost" size="sm" onClick={fitGraph} disabled={graphNodes.length === 0}>
          Fit
        </Button>
        <Button variant="ghost" size="sm" onClick={reflowGraph} disabled={graphNodes.length === 0}>
          Reflow
        </Button>
        <Button variant="primary" size="sm" onClick={addStarterGraph}>
          Starter graph
        </Button>
      </div>
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={handleConnect}
        onPaneClick={() => selectNode(null)}
        onInit={() => {
          requestAnimationFrame(() => {
            void fitView({ padding: 0.2, duration: 0 });
          });
        }}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} color="var(--border-subtle)" />
        <MiniMap pannable zoomable />
        <Controls showInteractive={false} />
      </ReactFlow>
      {graphNodes.length === 0 ? (
        <div className="plan-graph-empty">
          <div className="plan-graph-empty-title">No graph nodes</div>
          <div className="plan-graph-empty-copy">
            Add nodes from here or use the left palette, then connect handles to build the run order.
          </div>
          <div className="plan-graph-empty-actions">
            {PALETTE.slice(0, 3).map((entry, index) => (
              <Button
                key={entry.type}
                variant="ghost"
                size="sm"
                onClick={() => addNode(entry, index)}
              >
                {entry.meta.name}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
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
