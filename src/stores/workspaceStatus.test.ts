import test from "node:test";
import assert from "node:assert/strict";
import { deriveWorkspaceStatus } from "./workspaceStatus";

test("deriveWorkspaceStatus gives review the highest priority", () => {
  assert.equal(
    deriveWorkspaceStatus({
      pendingReview: true,
      activeNodeIds: ["node-1"],
      perNode: { "node-1": { status: "error" } },
    }),
    "review",
  );
});

test("deriveWorkspaceStatus treats queued and active nodes as running", () => {
  assert.equal(
    deriveWorkspaceStatus({ perNode: { "node-1": { status: "queued" } } }),
    "running",
  );
  assert.equal(deriveWorkspaceStatus({ activeNodeIds: ["node-1"] }), "running");
});

test("deriveWorkspaceStatus orders error before complete and idle last", () => {
  assert.equal(
    deriveWorkspaceStatus({
      perNode: {
        "node-1": { status: "complete" },
        "node-2": { status: "error" },
      },
    }),
    "error",
  );
  assert.equal(deriveWorkspaceStatus({ perNode: { "node-1": { status: "complete" } } }), "complete");
  assert.equal(deriveWorkspaceStatus({}), "idle");
});
