import type {
  ExecutionMode,
  ExecutionPlan,
  GraphEdge,
  NodeConfig,
} from "../../../src/core/task-graph.js";

export interface PlanDraftNode {
  id: string;
  provider: string;
  prompt: string;
  type?: string;
  workdir?: string | null;
  env?: Record<string, string>;
  timeoutMs?: number | null;
  skipped?: boolean;
}

export interface PlanDraft {
  origin: string;
  nodes: PlanDraftNode[];
  edges: GraphEdge[];
  mode: ExecutionMode;
}

export function toExecutionPlan(draft: PlanDraft): {
  plan: ExecutionPlan;
  skip: Set<string>;
} {
  const skip = new Set<string>();
  const nodes: NodeConfig[] = draft.nodes.map((node) => {
    if (node.skipped) {
      skip.add(node.id);
    }
    return {
      id: node.id,
      type: node.type ?? "worker:pty",
      provider: node.provider,
      prompt: node.prompt,
      workdir: node.workdir ?? null,
      env: node.env ?? {},
      timeout_ms: node.timeoutMs ?? null,
    };
  });

  const knownIds = new Set(nodes.map((node) => node.id));
  const edges = draft.edges.filter(
    (edge) => knownIds.has(edge.from) && knownIds.has(edge.to),
  );

  return {
    plan: {
      nodes,
      edges,
      mode: draft.mode,
    },
    skip,
  };
}

export function moveNode(draft: PlanDraft, fromIndex: number, toIndex: number): PlanDraft {
  if (
    fromIndex < 0 ||
    fromIndex >= draft.nodes.length ||
    toIndex < 0 ||
    toIndex >= draft.nodes.length ||
    fromIndex === toIndex
  ) {
    return draft;
  }
  const reordered = [...draft.nodes];
  const [removed] = reordered.splice(fromIndex, 1);
  reordered.splice(toIndex, 0, removed);
  return {
    ...draft,
    nodes: reordered,
    edges: rebuildLinearEdges(reordered),
  };
}

export function rebuildLinearEdges(nodes: PlanDraftNode[]): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (let i = 1; i < nodes.length; i++) {
    edges.push({ from: nodes[i - 1]!.id, to: nodes[i]!.id });
  }
  return edges;
}

export function insertNodeAfter(
  draft: PlanDraft,
  anchorIndex: number,
  node: PlanDraftNode,
): PlanDraft {
  const nodes = [...draft.nodes];
  const targetIndex = Math.min(Math.max(0, anchorIndex + 1), nodes.length);
  nodes.splice(targetIndex, 0, node);
  return {
    ...draft,
    nodes,
    edges: rebuildLinearEdges(nodes),
  };
}

export function removeNode(draft: PlanDraft, index: number): PlanDraft {
  if (index < 0 || index >= draft.nodes.length) {
    return draft;
  }
  const nodes = [...draft.nodes];
  nodes.splice(index, 1);
  return {
    ...draft,
    nodes,
    edges: rebuildLinearEdges(nodes),
  };
}

export function updateNode(
  draft: PlanDraft,
  index: number,
  patch: Partial<PlanDraftNode>,
): PlanDraft {
  if (index < 0 || index >= draft.nodes.length) {
    return draft;
  }
  const nodes = [...draft.nodes];
  nodes[index] = { ...nodes[index]!, ...patch };
  return { ...draft, nodes };
}
