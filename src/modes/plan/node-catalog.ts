import type { NodeMeta } from "@core/index";

export interface PaletteEntry {
  type: string;
  meta: NodeMeta;
  defaultPrompt: string;
  defaultProvider: string;
}

export const PALETTE: PaletteEntry[] = [
  {
    type: "worker:pty",
    meta: {
      name: "PTY Worker",
      category: "worker",
      colorToken: "node/worker",
      icon: "terminal",
    },
    defaultProvider: "claude-code",
    defaultPrompt: "작업 내용을 적습니다.",
  },
  {
    type: "worker:shell",
    meta: {
      name: "Shell",
      category: "worker",
      colorToken: "node/worker",
      icon: "command",
    },
    defaultProvider: "shell",
    defaultPrompt: "echo hello",
  },
  {
    type: "collector:result",
    meta: {
      name: "Result Collector",
      category: "collector",
      colorToken: "node/collector",
      icon: "git-merge",
    },
    defaultProvider: "shell",
    defaultPrompt: "여러 입력의 결과를 병합합니다.",
  },
  {
    type: "reviewer:llm",
    meta: {
      name: "LLM Reviewer",
      category: "reviewer",
      colorToken: "node/reviewer",
      icon: "search",
    },
    defaultProvider: "claude-code",
    defaultPrompt: "결과물을 리뷰합니다. 문제점과 개선안을 정리하세요.",
  },
  {
    type: "reviewer:human",
    meta: {
      name: "Human Review",
      category: "reviewer",
      colorToken: "node/reviewer",
      icon: "user-check",
    },
    defaultProvider: "shell",
    defaultPrompt: "(승인 대기 노드)",
  },
];

export function findPaletteEntry(type: string): PaletteEntry | undefined {
  return PALETTE.find((entry) => entry.type === type);
}
