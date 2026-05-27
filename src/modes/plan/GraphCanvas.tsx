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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "@xyflow/react/dist/style.css";

import { useExecutionStore, useGraphStore, useWorkspaceStore, type GraphEdge } from "@stores/index";
import { Button, IconButton } from "@design/components";
import AgentFlowNode, { type AgentFlowNodeData } from "./AgentFlowNode";
import { PALETTE, type PaletteEntry } from "./node-catalog";

const nodeTypes = { agent: AgentFlowNode };

type FlowNode = Node<AgentFlowNodeData, "agent">;
type NodePosition = { x: number; y: number };

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

function gridPosition(index: number, firstRowY = 120): NodePosition {
  return {
    x: 80 + (index % 3) * 320,
    y: firstRowY + Math.floor(index / 3) * 220,
  };
}

function isUsablePosition(position: unknown): position is NodePosition {
  if (!position || typeof position !== "object") {
    return false;
  }
  const candidate = position as Partial<NodePosition>;
  return Number.isFinite(candidate.x) && Number.isFinite(candidate.y);
}

function GraphCanvasInner() {
  const graphNodes = useGraphStore((state) => state.nodes);
  const graphEdges = useGraphStore((state) => state.edges);
  const setNodes = useGraphStore((state) => state.setNodes);
  const setEdges = useGraphStore((state) => state.setEdges);
  const upsertNode = useGraphStore((state) => state.upsertNode);
  const selectNode = useGraphStore((state) => state.selectNode);
  const perNode = useExecutionStore((state) => state.perNode);
  const activeProjectId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const activeProject = useWorkspaceStore((state) =>
    state.projects.find((project) => project.id === activeProjectId),
  );
  const repositories = useWorkspaceStore((state) => state.repositories);
  const { fitView } = useReactFlow();
  const hasAutoFitRef = useRef(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);

  const flowNodes = useMemo<FlowNode[]>(
    () =>
      graphNodes.map((node, index) => {
        const repoId = node.repoId ?? activeProject?.activeRepoId ?? null;
        const binding = activeProject?.repoBindings.find((item) => item.repoId === repoId);
        const repository = repositories.find((item) => item.id === repoId);
        return {
          id: node.id,
          type: "agent",
          position: isUsablePosition(node.position) ? node.position : gridPosition(index),
          initialWidth: 280,
          initialHeight: 120,
          data: {
            type: node.type,
            meta: node.meta,
            provider: node.provider,
            prompt: node.prompt,
            skipped: node.skipped,
            status: perNode[node.id]?.status ?? "idle",
            repoName: repository?.name,
            repoBranch: binding?.branch,
            worktreePolicy: node.worktreePolicy ?? "workspace",
          },
        };
      }),
    [activeProject, graphNodes, perNode, repositories],
  );

  const flowEdges = useMemo(() => graphEdges.map(toFlowEdge), [graphEdges]);

  useEffect(() => {
    if (flowNodes.length === 0) {
      hasAutoFitRef.current = false;
      return;
    }
    if (hasAutoFitRef.current) {
      return;
    }
    hasAutoFitRef.current = true;
    const fit = () => {
      void fitView({ padding: 0.25, duration: 200 });
    };
    const raf = requestAnimationFrame(fit);
    const retry = window.setTimeout(fit, 250);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(retry);
    };
  }, [fitView, flowNodes.length]);

  const handleNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      const positional = changes.filter(
        (change) => change.type === "position" || change.type === "remove",
      );
      if (positional.length > 0) {
        const next = applyNodeChanges<FlowNode>(positional, flowNodes);
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
      }

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
          ...gridPosition(index, 80),
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
      position: gridPosition(index),
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
        position: gridPosition(index),
      })),
    );
    selectNode(graphNodes[0]?.id ?? null);
    requestAnimationFrame(() => {
      void fitView({ padding: 0.25, duration: 200 });
    });
  }, [fitView, graphNodes, selectNode, setNodes]);

  const fitGraph = useCallback(() => {
    void fitView({ padding: 0.2, duration: 200 });
  }, [fitView]);

  const handleAddNode = useCallback(
    (entry: PaletteEntry) => {
      addNode(entry);
      setAddMenuOpen(false);
    },
    [addNode],
  );

  return (
    <div className="plan-graph-surface">
      <div className="plan-graph-toolbar">
        <span className="plan-graph-count">
          {graphNodes.length} node{graphNodes.length === 1 ? "" : "s"} · {graphEdges.length} edge
          {graphEdges.length === 1 ? "" : "s"}
        </span>
        <div className="plan-add-node">
          <Button
            variant="primary"
            size="sm"
            onClick={() => setAddMenuOpen((open) => !open)}
            aria-expanded={addMenuOpen}
            aria-haspopup="menu"
          >
            + Add node
          </Button>
          {addMenuOpen ? (
            <div className="plan-add-node-menu" role="menu" aria-label="Add graph node">
              {PALETTE.map((entry) => (
                <button
                  key={entry.type}
                  type="button"
                  className="plan-add-node-option"
                  role="menuitem"
                  onClick={() => handleAddNode(entry)}
                >
                  <span className="plan-add-node-name">{entry.meta.name}</span>
                  <span className="plan-add-node-type">{entry.type}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <IconButton
          aria-label="Fit graph"
          title="Fit graph"
          onClick={fitGraph}
          disabled={graphNodes.length === 0}
        >
          ⛶
        </IconButton>
        <IconButton
          aria-label="Reflow graph"
          title="Reflow graph"
          onClick={reflowGraph}
          disabled={graphNodes.length === 0}
        >
          ⇄
        </IconButton>
        <IconButton aria-label="Add starter graph" title="Starter graph" onClick={addStarterGraph}>
          ⎇
        </IconButton>
      </div>
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={handleConnect}
        onPaneClick={() => selectNode(null)}
        connectionRadius={40}
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
            Add a node to start the run graph.
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
