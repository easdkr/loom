import type { GraphEdge, GraphNode } from "@stores/index";
import { findPaletteEntry } from "@modes/plan/node-catalog";
import type { NodeMeta } from "@core/index";

export type AutoTemplate = "default" | "review-pipeline" | "single";

export interface AutoGenerationResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  reasoning: string;
}

const WORKER_META = (name: string, type = "worker:pty"): NodeMeta =>
  findPaletteEntry(type)?.meta ?? {
    name,
    category: "worker",
    colorToken: "node/worker",
  };

function nodeId(prefix: string, index: number): string {
  return `${prefix}-${(index + 1).toString().padStart(2, "0")}`;
}

function gridPosition(index: number, width = 320, height = 240, perRow = 3) {
  return {
    x: 40 + (index % perRow) * width,
    y: 40 + Math.floor(index / perRow) * height,
  };
}

function linearEdges(nodes: GraphNode[]): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (let i = 1; i < nodes.length; i += 1) {
    const source = nodes[i - 1].id;
    const target = nodes[i].id;
    edges.push({ id: `${source}->${target}`, source, target });
  }
  return edges;
}

export function detectComplexity(origin: string): "single" | "complex" {
  const lc = origin.toLowerCase();
  const triggers = [
    "병렬",
    "parallel",
    "리뷰",
    "review",
    "pipeline",
    "통합",
    "여러",
    "multi",
  ];
  const ambitious = triggers.some((token) => lc.includes(token));
  return ambitious || origin.split(/\s+/).length > 20 ? "complex" : "single";
}

export function generateAutoPlan(
  origin: string,
  template: AutoTemplate,
  providers: string[],
): AutoGenerationResult {
  const pick = (preferred: string, fallback = "shell"): string => {
    if (providers.includes(preferred)) return preferred;
    if (providers.includes(fallback)) return fallback;
    return providers[0] ?? fallback;
  };
  const trimmed = origin.trim();

  if (template === "single") {
    const nodes: GraphNode[] = [
      {
        id: nodeId("auto", 0),
        type: "worker:pty",
        meta: WORKER_META("Single Worker"),
        provider: pick("croxy"),
        prompt: trimmed,
        position: gridPosition(0),
      },
    ];
    return {
      nodes,
      edges: [],
      reasoning: "단순 작업으로 판단해 노드 1개로 실행합니다.",
    };
  }

  if (template === "review-pipeline") {
    const implementer = pick("codex");
    const reviewer = pick("croxy");
    const tester = pick("shell");
    const nodes: GraphNode[] = [
      {
        id: nodeId("rp", 0),
        type: "worker:pty",
        meta: WORKER_META("Implementer"),
        provider: implementer,
        prompt: `요청한 변경을 구현하세요.\n\n${trimmed}`,
        position: gridPosition(0),
      },
      {
        id: nodeId("rp", 1),
        type: "reviewer:llm",
        meta: WORKER_META("LLM Reviewer", "reviewer:llm"),
        provider: reviewer,
        prompt: `방금 변경된 부분을 리뷰하고, 보안·테스트 누락을 지적하세요.\n\n${trimmed}`,
        position: gridPosition(1),
      },
      {
        id: nodeId("rp", 2),
        type: "worker:shell",
        meta: WORKER_META("Tester", "worker:shell"),
        provider: tester,
        prompt: "pnpm test --silent 2>&1 | tail -200",
        position: gridPosition(2),
      },
    ];
    return {
      nodes,
      edges: linearEdges(nodes),
      reasoning: "리뷰가 필요한 변경이라 구현 → LLM 리뷰 → 테스트의 3단 파이프라인을 구성했습니다.",
    };
  }

  // default: design → implement → review (linear)
  const designer = pick("croxy");
  const implementer = pick("codex");
  const reviewer = pick("croxy");
  const nodes: GraphNode[] = [
    {
      id: nodeId("auto", 0),
      type: "worker:pty",
      meta: WORKER_META("Designer"),
      provider: designer,
      prompt: `다음 작업에 대한 접근 방식과 영향을 정리하세요.\n\nTASK:\n${trimmed}`,
      position: gridPosition(0),
    },
    {
      id: nodeId("auto", 1),
      type: "worker:pty",
      meta: WORKER_META("Implementer"),
      provider: implementer,
      prompt: `이전 단계의 설계를 바탕으로 변경을 구현하세요.\n\nTASK:\n${trimmed}`,
      position: gridPosition(1),
    },
    {
      id: nodeId("auto", 2),
      type: "reviewer:llm",
      meta: WORKER_META("LLM Reviewer", "reviewer:llm"),
      provider: reviewer,
      prompt: `구현 결과를 리뷰하고, 무엇이 바뀌었고 어떤 위험이 남았는지 정리하세요.\n\nTASK:\n${trimmed}`,
      position: gridPosition(2),
    },
  ];
  return {
    nodes,
    edges: linearEdges(nodes),
    reasoning: "복잡한 작업이라 설계 → 구현 → 리뷰의 3단 그래프로 분해했습니다.",
  };
}
