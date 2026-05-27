import { EventEmitter } from "node:events";
import path from "node:path";
import type { ExecutionPlan, NodeConfig } from "../../../src/core/task-graph.js";
import type { ProviderConfig } from "../../../src/providers/types.js";
import { topologicalBatches } from "./topology.js";
import { PtyMultiplexer } from "../pty/ptyMultiplexer.js";
import { isSuccessfulOutcome, type PtyOutcome } from "../pty/ptySession.js";

export interface PlanRunResult {
  runId: string;
  completed: string[];
  skipped: string[];
  failed: string[];
  outcomes: Record<string, PtyOutcome>;
}

export interface PlanExecutorOptions {
  runId: string;
  plan: ExecutionPlan;
  providers: Map<string, ProviderConfig>;
  skip?: Set<string>;
  concurrencyLimit?: number;
  projectRoot?: string;
}

type UpstreamOutput = [nodeId: string, result: string];

export function resolveNodeWorkdir(
  workdir: string | null | undefined,
  projectRoot?: string,
): string {
  const baseRoot = projectRoot ?? process.cwd();
  if (!workdir) {
    return baseRoot;
  }
  return path.isAbsolute(workdir) ? workdir : path.resolve(baseRoot, workdir);
}

function buildUpstreamMap(plan: ExecutionPlan): Map<string, string[]> {
  const upstream = new Map<string, string[]>();
  for (const edge of plan.edges) {
    const parents = upstream.get(edge.to) ?? [];
    parents.push(edge.from);
    upstream.set(edge.to, parents);
  }
  return upstream;
}

function mergeUpstreamText(parts: UpstreamOutput[]): string {
  return parts.map(([id, result]) => `[${id}]\n${result}`).join("\n\n");
}

function providerIsAgent(provider: ProviderConfig): boolean {
  if (provider.display_mode === "agent") {
    return true;
  }
  const identity = `${provider.name} ${provider.command}`.toLowerCase();
  return ["claude", "croxy", "codex", "cursor"].some((needle) =>
    identity.includes(needle),
  );
}

function shouldAttachUpstreamToPrompt(
  node: NodeConfig,
  provider: ProviderConfig,
): boolean {
  if (node.type === "reviewer:llm") {
    return true;
  }
  return node.type === "worker:pty" && providerIsAgent(provider);
}

export function composeNodePrompt(
  node: NodeConfig,
  provider: ProviderConfig,
  upstreamOutputs: UpstreamOutput[],
): string {
  if (
    upstreamOutputs.length === 0 ||
    !shouldAttachUpstreamToPrompt(node, provider)
  ) {
    return node.prompt;
  }

  const prefix = node.prompt.trimEnd();
  const separator = prefix ? "\n\n" : "";
  return `${prefix}${separator}---
Upstream node outputs are included below.
If this task involves code work, the current working directory is the source of truth. Inspect \`git status\` and \`git diff\` yourself before reviewing or changing code; use the upstream text as context, not as a substitute for the filesystem.

Upstream outputs:
${mergeUpstreamText(upstreamOutputs)}`;
}

export class PlanExecutor extends EventEmitter {
  readonly runId: string;
  readonly plan: ExecutionPlan;
  readonly multiplexer: PtyMultiplexer;
  readonly projectRoot?: string;
  private readonly providers: Map<string, ProviderConfig>;
  private readonly skip: Set<string>;
  private readonly upstream: Map<string, string[]>;
  private readonly outcomes = new Map<string, PtyOutcome>();
  private readonly skipped: string[] = [];

  constructor(options: PlanExecutorOptions) {
    super();
    this.runId = options.runId;
    this.plan = options.plan;
    this.projectRoot = options.projectRoot;
    this.providers = options.providers;
    this.skip = options.skip ?? new Set();
    this.upstream = buildUpstreamMap(options.plan);
    this.multiplexer = new PtyMultiplexer({
      concurrencyLimit: options.concurrencyLimit ?? 2,
    });

    this.multiplexer.on("start", (event: { nodeId: string }) => {
      this.emit("node-start", { runId: this.runId, nodeId: event.nodeId });
    });
    this.multiplexer.on("data", (event: { nodeId: string; chunk: string }) => {
      this.emit("data", { runId: this.runId, ...event });
    });
    this.multiplexer.on("complete", (outcome: PtyOutcome) => {
      this.outcomes.set(outcome.nodeId, outcome);
      this.emit("node-complete", { runId: this.runId, outcome });
    });
    this.multiplexer.on("error", (event: { nodeId: string; error: string }) => {
      this.emit("node-error", { runId: this.runId, ...event });
    });
  }

  cancel(): void {
    this.multiplexer.killAll();
  }

  async run(): Promise<PlanRunResult> {
    let batches: NodeConfig[][];
    try {
      batches = topologicalBatches(this.plan);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit("plan-error", { runId: this.runId, error: message });
      throw error;
    }

    const failed: string[] = [];

    for (const batch of batches) {
      const promises: Promise<void>[] = [];
      for (const node of batch) {
        if (this.skip.has(node.id)) {
          this.skipped.push(node.id);
          this.emit("node-skip", { runId: this.runId, nodeId: node.id });
          continue;
        }

        const provider = this.providers.get(node.provider);
        if (!provider) {
          failed.push(node.id);
          const message = `unknown provider for node ${node.id}: ${node.provider}`;
          this.emit("node-error", { runId: this.runId, nodeId: node.id, error: message });
          continue;
        }

        promises.push(this.launchNode(node, provider));
      }
      await Promise.all(promises);

      for (const node of batch) {
        const outcome = this.outcomes.get(node.id);
        if (outcome && !isSuccessfulOutcome(outcome)) {
          failed.push(node.id);
        }
      }

      if (failed.length > 0) {
        break;
      }
    }

    const result: PlanRunResult = {
      runId: this.runId,
      completed: Array.from(this.outcomes.keys()).filter((id) => {
        const outcome = this.outcomes.get(id);
        return outcome ? isSuccessfulOutcome(outcome) : false;
      }),
      skipped: [...this.skipped],
      failed,
      outcomes: Object.fromEntries(this.outcomes.entries()),
    };

    this.emit("plan-complete", result);
    return result;
  }

  private async launchNode(node: NodeConfig, provider: ProviderConfig): Promise<void> {
    const upstreamOutputs = (this.upstream.get(node.id) ?? []).map(
      (parent) => [parent, this.outcomes.get(parent)?.result ?? ""] as UpstreamOutput,
    );
    await this.multiplexer.spawn({
      nodeId: node.id,
      provider,
      prompt: composeNodePrompt(node, provider, upstreamOutputs),
      workdir: resolveNodeWorkdir(node.workdir, this.projectRoot),
      env: node.env,
      timeoutMs: node.timeout_ms ?? null,
    });

    await new Promise<void>((resolve) => {
      const handler = (outcome: PtyOutcome) => {
        if (outcome.nodeId !== node.id) {
          return;
        }
        this.multiplexer.off("complete", handler);
        resolve();
      };
      this.multiplexer.on("complete", handler);
    });
  }
}
