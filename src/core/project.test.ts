import test from "node:test";
import assert from "node:assert/strict";
import {
  createWorkspaceView,
  DEFAULT_WORKSPACE_MODE,
  normalizeWorkspace,
  type Repository,
  type Workspace,
} from "./project";

const repository: Repository = {
  id: "repo-1",
  name: "loom",
  sourceRoot: "/workspace/loom",
  remoteUrl: null,
  defaultBranch: "main",
  kind: "local",
  createdAt: 1,
  lastOpenedAt: 1,
};

const workspace: Workspace = {
  id: "workspace-1",
  name: "Loom workspace",
  repoBindings: [
    {
      repoId: repository.id,
      branch: "main",
      worktreePath: "/workspace/loom",
      bindingKind: "existing-root",
    },
  ],
  activeRepoId: repository.id,
  createdAt: 1,
  lastOpenedAt: 2,
};

test("normalizeWorkspace fills missing mode without changing registry version", () => {
  assert.equal(normalizeWorkspace(workspace).mode, DEFAULT_WORKSPACE_MODE);
  assert.equal(normalizeWorkspace({ ...workspace, mode: "auto" }).mode, "auto");
});

test("createWorkspaceView exposes active repo metadata in one stable view", () => {
  const view = createWorkspaceView(workspace, [repository]);

  assert.ok(view);
  assert.equal(view.root, "/workspace/loom");
  assert.equal(view.repoCount, 1);
  assert.equal(view.activeBinding.branch, "main");
  assert.equal(view.activeRepository?.name, "loom");
  assert.equal(view.displayBranch, "main");
  assert.equal(view.displayPath, "/workspace/loom");
});

test("createWorkspaceView falls back to first binding when active repo is stale", () => {
  const view = createWorkspaceView({ ...workspace, activeRepoId: "missing-repo" }, [repository]);

  assert.ok(view);
  assert.equal(view.activeRepoId, repository.id);
  assert.equal(view.root, "/workspace/loom");
});
