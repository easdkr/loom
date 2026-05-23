import { test } from "node:test";
import assert from "node:assert/strict";
import { PlanExecutor } from "../src/graph/planExecutor.js";
import { fallbackProviders } from "../../src/providers/index.js";
import type { ExecutionPlan } from "../../src/core/task-graph.js";

const shellProvider = fallbackProviders.find((provider) => provider.name === "shell");
if (!shellProvider) {
  throw new Error("shell provider missing from fallback registry");
}
const providersMap = new Map([[shellProvider.name, shellProvider]]);

function shellNode(id: string, prompt: string) {
  return {
    id,
    type: "worker:pty",
    provider: shellProvider!.name,
    prompt,
    workdir: null,
    env: {},
    timeout_ms: 15000,
  };
}

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
