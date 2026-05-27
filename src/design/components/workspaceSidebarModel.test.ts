import test from "node:test";
import assert from "node:assert/strict";
import type { Project } from "@core/index";
import { groupWorkspaceEntries, WORKSPACE_STATUS_ORDER } from "./workspaceSidebarModel";

function project(id: string, lastOpenedAt: number): Project {
  return {
    id,
    name: id,
    repoBindings: [
      {
        repoId: `${id}-repo`,
        branch: "main",
        worktreePath: `/tmp/${id}`,
        bindingKind: "existing-root",
      },
    ],
    activeRepoId: `${id}-repo`,
    mode: "plan",
    createdAt: 1,
    lastOpenedAt,
    activeBinding: {
      repoId: `${id}-repo`,
      branch: "main",
      worktreePath: `/tmp/${id}`,
      bindingKind: "existing-root",
    },
    repoCount: 1,
    root: `/tmp/${id}`,
    displayBranch: "main",
    displayPath: `/tmp/${id}`,
  };
}

test("groupWorkspaceEntries follows the fixed status order", () => {
  const grouped = groupWorkspaceEntries([
    { project: project("idle", 1), status: "idle" },
    { project: project("review", 1), status: "review" },
    { project: project("running", 1), status: "running" },
    { project: project("complete", 1), status: "complete" },
    { project: project("error", 1), status: "error" },
  ]);

  assert.deepEqual(
    grouped.map((group) => group[0]?.status),
    WORKSPACE_STATUS_ORDER,
  );
});

test("groupWorkspaceEntries sorts each bucket by last activity", () => {
  const grouped = groupWorkspaceEntries([
    { project: project("old", 1), status: "running" },
    { project: project("new", 2), status: "running" },
  ]);

  const runningGroup = grouped[WORKSPACE_STATUS_ORDER.indexOf("running")];
  assert.deepEqual(runningGroup.map((entry) => entry.project.id), ["new", "old"]);
});
