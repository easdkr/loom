import type { PlanDraft, PlanDraftNode } from "./planSchema.js";
import { rebuildLinearEdges } from "./planSchema.js";
import type { ProviderConfig } from "../../../src/providers/types.js";

export interface GeneratePlanOptions {
  origin: string;
  providers: ProviderConfig[];
  template?: "single" | "default" | "review-pipeline" | (string & {});
  preferredProvider?: string;
}

function pickProvider(
  providers: ProviderConfig[],
  preferred: string | undefined,
  fallback: string,
): string {
  if (preferred && providers.some((provider) => provider.name === preferred)) {
    return preferred;
  }
  if (providers.some((provider) => provider.name === fallback)) {
    return fallback;
  }
  return providers[0]?.name ?? fallback;
}

function nodeId(prefix: string, index: number): string {
  return `${prefix}-${index + 1}`;
}

export function generatePlan(options: GeneratePlanOptions): PlanDraft {
  const template = options.template ?? "default";
  const providers = options.providers;
  const origin = options.origin.trim();

  if (template === "single") {
    return singleNodePlan(origin, providers, options.preferredProvider);
  }
  if (template === "review-pipeline") {
    return reviewPipelinePlan(origin, providers);
  }
  return defaultPlan(origin, providers, options.preferredProvider);
}

function singleNodePlan(
  origin: string,
  providers: ProviderConfig[],
  preferred: string | undefined,
): PlanDraft {
  const provider = pickProvider(providers, preferred, "claude-code");
  const nodes: PlanDraftNode[] = [
    {
      id: nodeId("node", 0),
      provider,
      prompt: origin,
      type: "worker:pty",
    },
  ];
  return {
    origin,
    nodes,
    edges: [],
    mode: "sequential",
  };
}

function defaultPlan(
  origin: string,
  providers: ProviderConfig[],
  preferred: string | undefined,
): PlanDraft {
  const designer = pickProvider(providers, preferred, "claude-code");
  const implementer = pickProvider(providers, undefined, "codex");
  const reviewer = pickProvider(providers, undefined, "claude-code");

  const nodes: PlanDraftNode[] = [
    {
      id: nodeId("plan", 0),
      provider: designer,
      type: "worker:pty",
      prompt: `Design the approach for the following task. Produce a concise plan with file targets and risks.\n\nTASK:\n${origin}`,
    },
    {
      id: nodeId("plan", 1),
      provider: implementer,
      type: "worker:pty",
      prompt: `Implement the plan from the previous step. Make the minimal code changes required to satisfy the task. Run the project's quick checks if they exist.\n\nTASK:\n${origin}`,
    },
    {
      id: nodeId("plan", 2),
      provider: reviewer,
      type: "worker:pty",
      prompt: `Review the implementation from the previous step. Summarize what changed, call out any risks, and confirm whether the task is complete.\n\nTASK:\n${origin}`,
    },
  ];

  return {
    origin,
    nodes,
    edges: rebuildLinearEdges(nodes),
    mode: "sequential",
  };
}

function reviewPipelinePlan(origin: string, providers: ProviderConfig[]): PlanDraft {
  const implementer = pickProvider(providers, undefined, "codex");
  const reviewer = pickProvider(providers, undefined, "claude-code");
  const tester = pickProvider(providers, undefined, "shell");

  const nodes: PlanDraftNode[] = [
    {
      id: nodeId("rp", 0),
      provider: implementer,
      type: "worker:pty",
      prompt: `Implement the requested change.\n\n${origin}`,
    },
    {
      id: nodeId("rp", 1),
      provider: reviewer,
      type: "worker:pty",
      prompt: `Review the implementation and flag any issues, security concerns, or missing tests.\n\n${origin}`,
    },
    {
      id: nodeId("rp", 2),
      provider: tester,
      type: "worker:pty",
      prompt: "pnpm test --silent 2>&1 | tail -200",
    },
  ];

  return {
    origin,
    nodes,
    edges: rebuildLinearEdges(nodes),
    mode: "sequential",
  };
}

export function defaultTemplates(): string[] {
  return ["single", "default", "review-pipeline"];
}
