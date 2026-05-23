export type ExecutionMode = "sequential" | "parallel" | "dag";

export interface ExecutionPlan {
  nodes: NodeConfig[];
  edges: GraphEdge[];
  mode: ExecutionMode;
}

export interface NodeConfig {
  id: string;
  type: string;
  provider: string;
  prompt: string;
  workdir?: string | null;
  env?: Record<string, string>;
  timeout_ms?: number | null;
}

export interface GraphEdge {
  from: string;
  to: string;
}

export function topologicalBatches(plan: ExecutionPlan): NodeConfig[][] {
  if (plan.nodes.length === 0) {
    throw new Error("execution plan has no nodes");
  }

  if (plan.mode === "sequential") {
    return plan.nodes.map((node) => [node]);
  }

  const nodesById = new Map(plan.nodes.map((node) => [node.id, node]));
  if (nodesById.size !== plan.nodes.length) {
    throw new Error("execution plan contains duplicate node ids");
  }

  const incoming = new Map(plan.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(plan.nodes.map((node) => [node.id, [] as string[]]));

  for (const edge of plan.edges) {
    if (!nodesById.has(edge.from)) {
      throw new Error(`edge references unknown source node: ${edge.from}`);
    }
    if (!nodesById.has(edge.to)) {
      throw new Error(`edge references unknown target node: ${edge.to}`);
    }

    outgoing.get(edge.from)?.push(edge.to);
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  }

  let ready = Array.from(incoming.entries())
    .filter(([, count]) => count === 0)
    .map(([id]) => id);
  const batches: NodeConfig[][] = [];
  let visited = 0;

  while (ready.length > 0) {
    const batchIds = ready;
    ready = [];
    const batch: NodeConfig[] = [];

    for (const id of batchIds) {
      const node = nodesById.get(id);
      if (!node) {
        continue;
      }

      visited += 1;
      batch.push(node);

      for (const target of outgoing.get(id) ?? []) {
        const nextCount = (incoming.get(target) ?? 0) - 1;
        incoming.set(target, nextCount);
        if (nextCount === 0) {
          ready.push(target);
        }
      }
    }

    batches.push(batch);
  }

  if (visited !== nodesById.size) {
    throw new Error("execution plan contains a cycle");
  }

  return batches;
}
