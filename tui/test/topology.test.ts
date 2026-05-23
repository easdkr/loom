import { test } from "node:test";
import assert from "node:assert/strict";
import { topologicalBatches } from "../src/graph/topology.js";
import type { ExecutionPlan, NodeConfig } from "../../src/core/task-graph.js";

function node(id: string): NodeConfig {
  return {
    id,
    type: "worker:pty",
    provider: "shell",
    prompt: "echo ok",
    workdir: null,
    env: {},
    timeout_ms: null,
  };
}

test("topologicalBatches groups independent nodes into parallel batches", () => {
  const plan: ExecutionPlan = {
    nodes: [node("a"), node("b"), node("c")],
    edges: [
      { from: "a", to: "c" },
      { from: "b", to: "c" },
    ],
    mode: "dag",
  };
  const batches = topologicalBatches(plan);
  assert.equal(batches.length, 2);
  const firstIds = batches[0].map((node) => node.id).sort();
  assert.deepEqual(firstIds, ["a", "b"]);
  assert.equal(batches[1][0].id, "c");
});

test("topologicalBatches keeps sequential mode strictly ordered", () => {
  const plan: ExecutionPlan = {
    nodes: [node("a"), node("b"), node("c")],
    edges: [],
    mode: "sequential",
  };
  const batches = topologicalBatches(plan);
  assert.equal(batches.length, 3);
  assert.deepEqual(
    batches.map((batch) => batch[0].id),
    ["a", "b", "c"],
  );
});

test("topologicalBatches rejects cycles", () => {
  const plan: ExecutionPlan = {
    nodes: [node("a"), node("b")],
    edges: [
      { from: "a", to: "b" },
      { from: "b", to: "a" },
    ],
    mode: "dag",
  };
  assert.throws(() => topologicalBatches(plan), /cycle/);
});

test("topologicalBatches rejects empty plans", () => {
  const plan: ExecutionPlan = { nodes: [], edges: [], mode: "dag" };
  assert.throws(() => topologicalBatches(plan), /no nodes/);
});

test("topologicalBatches rejects unknown edge endpoints", () => {
  const plan: ExecutionPlan = {
    nodes: [node("a")],
    edges: [{ from: "a", to: "ghost" }],
    mode: "dag",
  };
  assert.throws(() => topologicalBatches(plan), /unknown target/);
});
