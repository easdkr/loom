import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { composeNodePrompt, PlanExecutor } from "../src/graph/planExecutor.js";
import { fallbackProviders } from "../../src/providers/index.js";
import type { ExecutionPlan } from "../../src/core/task-graph.js";
import type { ProviderConfig } from "../../src/providers/types.js";

const shellProvider = fallbackProviders.find((provider) => provider.name === "shell");
if (!shellProvider) {
  throw new Error("shell provider missing from fallback registry");
}
const providersMap = new Map([[shellProvider.name, shellProvider]]);

const agentProvider: ProviderConfig = {
  ...shellProvider,
  name: "codex",
  command: "codex",
  display_mode: "agent",
};

function shellNode(id: string, prompt: string, workdir: string | null = null) {
  return {
    id,
    type: "worker:pty",
    provider: shellProvider!.name,
    prompt,
    workdir,
    env: {},
    timeout_ms: 15000,
  };
}

test("composeNodePrompt attaches upstream output to LLM reviewer prompts", () => {
  const prompt = composeNodePrompt(
    {
      id: "review",
      type: "reviewer:llm",
      provider: agentProvider.name,
      prompt: "Review the result.",
      workdir: null,
      env: {},
      timeout_ms: null,
    },
    agentProvider,
    [["worker", "changed src/main.ts"]],
  );

  assert.match(prompt, /Review the result\./);
  assert.match(prompt, /\[worker\]\nchanged src\/main\.ts/);
  assert.match(prompt, /git status/);
  assert.match(prompt, /git diff/);
});

test("composeNodePrompt leaves shell command prompts unchanged", () => {
  const prompt = composeNodePrompt(
    shellNode("test", "pnpm test"),
    shellProvider,
    [["worker", "large report"]],
  );

  assert.equal(prompt, "pnpm test");
});

test(
  "PlanExecutor runs a sequential 2-node plan via real shell PTYs",
  { timeout: 60_000 },
  async () => {
    const plan: ExecutionPlan = {
      nodes: [
        shellNode("alpha", "printf 'alpha-output\\n'"),
        shellNode("beta", "printf 'beta-output\\n'"),
      ],
      edges: [{ from: "alpha", to: "beta" }],
      mode: "sequential",
    };

    const executor = new PlanExecutor({
      runId: "plan-exec-test",
      plan,
      providers: providersMap,
    });

    const startedNodes: string[] = [];
    const completedNodes: string[] = [];
    executor.on("node-start", (event: { nodeId: string }) => {
      startedNodes.push(event.nodeId);
    });
    executor.on("node-complete", (event: { outcome: { nodeId: string } }) => {
      completedNodes.push(event.outcome.nodeId);
    });

    const result = await executor.run();
    assert.deepEqual(startedNodes, ["alpha", "beta"]);
    assert.deepEqual(completedNodes, ["alpha", "beta"]);
    assert.deepEqual(result.completed.sort(), ["alpha", "beta"]);
    assert.equal(result.failed.length, 0);
    assert.match(result.outcomes.alpha!.result, /alpha-output/);
    assert.match(result.outcomes.beta!.result, /beta-output/);
  },
);

test(
  "PlanExecutor honors skipped nodes",
  { timeout: 60_000 },
  async () => {
    const plan: ExecutionPlan = {
      nodes: [
        shellNode("first", "printf 'first\\n'"),
        shellNode("middle", "printf 'middle\\n'"),
        shellNode("last", "printf 'last\\n'"),
      ],
      edges: [
        { from: "first", to: "middle" },
        { from: "middle", to: "last" },
      ],
      mode: "sequential",
    };

    const executor = new PlanExecutor({
      runId: "plan-skip-test",
      plan,
      providers: providersMap,
      skip: new Set(["middle"]),
    });

    const skipped: string[] = [];
    executor.on("node-skip", (event: { nodeId: string }) => skipped.push(event.nodeId));

    const result = await executor.run();
    assert.deepEqual(skipped, ["middle"]);
    assert.deepEqual(result.skipped, ["middle"]);
    assert.deepEqual(result.completed.sort(), ["first", "last"]);
    assert.equal(result.outcomes.middle, undefined);
  },
);

test(
  "PlanExecutor resolves null and relative node workdirs against the project root",
  { timeout: 60_000 },
  async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loom-project-root-"));
    const nestedRoot = path.join(projectRoot, "nested");
    await fs.mkdir(nestedRoot, { recursive: true });

    try {
      const plan: ExecutionPlan = {
        nodes: [
          shellNode("root-node", "pwd"),
          shellNode("nested-node", "pwd", "nested"),
        ],
        edges: [{ from: "root-node", to: "nested-node" }],
        mode: "sequential",
      };

      const executor = new PlanExecutor({
        runId: "plan-project-root-test",
        plan,
        providers: providersMap,
        projectRoot,
      });

      const result = await executor.run();
      assert.equal(result.failed.length, 0);
      assert.match(result.outcomes["root-node"]!.result, new RegExp(projectRoot.replaceAll("\\", "\\\\")));
      assert.match(
        result.outcomes["nested-node"]!.result,
        new RegExp(nestedRoot.replaceAll("\\", "\\\\")),
      );
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  },
);
