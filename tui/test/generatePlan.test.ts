import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePlan } from "../src/plan/generatePlan.js";
import { fallbackProviders } from "../../src/providers/index.js";
import {
  insertNodeAfter,
  moveNode,
  rebuildLinearEdges,
  removeNode,
  toExecutionPlan,
  updateNode,
} from "../src/plan/planSchema.js";

test("default template generates a 3-step sequential plan", () => {
  const draft = generatePlan({
    origin: "Add OAuth login",
    providers: fallbackProviders,
  });
  assert.equal(draft.nodes.length, 3);
  assert.equal(draft.mode, "sequential");
  assert.equal(draft.edges.length, 2);
  assert.equal(draft.edges[0].from, draft.nodes[0].id);
  assert.equal(draft.edges[0].to, draft.nodes[1].id);
});

test("single template generates a single-node plan", () => {
  const draft = generatePlan({
    origin: "ls -la",
    providers: fallbackProviders,
    template: "single",
    preferredProvider: "shell",
  });
  assert.equal(draft.nodes.length, 1);
  assert.equal(draft.nodes[0].provider, "shell");
});

test("planSchema editors keep edges consistent", () => {
  const draft = generatePlan({
    origin: "Refactor module",
    providers: fallbackProviders,
  });

  const inserted = insertNodeAfter(draft, 0, {
    id: "extra",
    provider: "shell",
    prompt: "echo extra",
  });
  assert.equal(inserted.nodes.length, 4);
  assert.deepEqual(
    inserted.edges.map((edge) => [edge.from, edge.to]),
    [
      [inserted.nodes[0].id, inserted.nodes[1].id],
      [inserted.nodes[1].id, inserted.nodes[2].id],
      [inserted.nodes[2].id, inserted.nodes[3].id],
    ],
  );

  const moved = moveNode(inserted, 0, 2);
  assert.equal(moved.nodes[2].id, draft.nodes[0].id);
  assert.deepEqual(moved.edges, rebuildLinearEdges(moved.nodes));

  const removed = removeNode(moved, 1);
  assert.equal(removed.nodes.length, 3);
  assert.deepEqual(removed.edges, rebuildLinearEdges(removed.nodes));
});

test("toExecutionPlan honors skipped nodes", () => {
  const draft = generatePlan({
    origin: "Run pipeline",
    providers: fallbackProviders,
  });
  const updated = updateNode(draft, 1, { skipped: true });
  const { plan, skip } = toExecutionPlan(updated);
  assert.equal(plan.nodes.length, 3);
  assert.ok(skip.has(updated.nodes[1].id));
  assert.ok(!skip.has(updated.nodes[0].id));
});
