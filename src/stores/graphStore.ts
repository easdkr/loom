import { create } from "zustand";
import type { NodeMeta } from "@core/index";

export interface GraphNode {
  id: string;
  type: string;
  meta: NodeMeta;
  provider: string;
  prompt: string;
  workdir?: string | null;
  skipped?: boolean;
  position: { x: number; y: number };
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
}

interface GraphState {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedNodeId: string | null;

  setNodes: (nodes: GraphNode[]) => void;
  setEdges: (edges: GraphEdge[]) => void;
  upsertNode: (node: GraphNode) => void;
  updateNode: (id: string, patch: Partial<GraphNode>) => void;
  removeNode: (id: string) => void;
  addEdge: (edge: GraphEdge) => void;
  removeEdge: (id: string) => void;
  selectNode: (id: string | null) => void;
  clear: () => void;
}

export const useGraphStore = create<GraphState>((set) => ({
  nodes: [],
  edges: [],
  selectedNodeId: null,

  setNodes: (nodes) => set({ nodes }),
  setEdges: (edges) => set({ edges }),
  upsertNode: (node) =>
    set((state) => {
      const idx = state.nodes.findIndex((n) => n.id === node.id);
      if (idx === -1) {
        return { nodes: [...state.nodes, node] };
      }
      const next = state.nodes.slice();
      next[idx] = node;
      return { nodes: next };
    }),
  updateNode: (id, patch) =>
    set((state) => ({
      nodes: state.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
    })),
  removeNode: (id) =>
    set((state) => ({
      nodes: state.nodes.filter((n) => n.id !== id),
      edges: state.edges.filter((e) => e.source !== id && e.target !== id),
      selectedNodeId: state.selectedNodeId === id ? null : state.selectedNodeId,
    })),
  addEdge: (edge) =>
    set((state) => {
      if (state.edges.some((e) => e.source === edge.source && e.target === edge.target)) {
        return state;
      }
      return { edges: [...state.edges, edge] };
    }),
  removeEdge: (id) =>
    set((state) => ({ edges: state.edges.filter((e) => e.id !== id) })),
  selectNode: (id) => set({ selectedNodeId: id }),
  clear: () => set({ nodes: [], edges: [], selectedNodeId: null }),
}));
