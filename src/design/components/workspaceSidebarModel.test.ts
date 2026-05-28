import test from "node:test";
import assert from "node:assert/strict";
import type { Project, Repository, WorkspaceRepoBinding } from "@core/index";
import {
  ALL_REPOSITORIES_FILTER_ID,
  buildRepositoryWorktreeView,
  groupWorkspaceEntries,
  parseWorkspaceSidebarViewMode,
  WORKSPACE_STATUS_ORDER,
  workspaceDirtyKey,
} from "./workspaceSidebarModel";

function repository(id: string, name = id, lastOpenedAt = 1): Repository {
  return {
    id,
    name,
    sourceRoot: `/repo/${id}`,
    remoteUrl: null,
    defaultBranch: "main",
    kind: "local",
    createdAt: 1,
    lastOpenedAt,
  };
}

function binding(repoId: string, worktreePath: string, branch = "main"): WorkspaceRepoBinding {
  return {
    repoId,
    branch,
    worktreePath,
    bindingKind: "worktree",
  };
}

function project(
  id: string,
  lastOpenedAt: number,
  repoBindings: WorkspaceRepoBinding[] = [binding(`${id}-repo`, `/tmp/${id}`)],
): Project {
  const activeBinding = repoBindings[0];
  return {
    id,
    name: id,
    repoBindings,
    activeRepoId: activeBinding.repoId,
    mode: "plan",
    createdAt: 1,
    lastOpenedAt,
    activeBinding,
    repoCount: repoBindings.length,
    root: activeBinding.worktreePath,
    displayBranch: activeBinding.branch,
    displayPath: activeBinding.worktreePath,
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

test("buildRepositoryWorktreeView groups one repository chip with multiple worktrees", () => {
  const repo = repository("repo-1", "Loom");
  const first = project("workspace-a", 10, [binding(repo.id, "/tmp/a", "feature/a")]);
  const second = project("workspace-b", 20, [binding(repo.id, "/tmp/b", "feature/b")]);

  const view = buildRepositoryWorktreeView({
    projects: [first, second],
    repositories: [repo],
    selectedRepositoryId: repo.id,
    dirtyByWorktree: {},
    statusByProject: {},
  });

  assert.equal(view.chips.find((chip) => chip.id === repo.id)?.worktreeCount, 2);
  assert.deepEqual(view.entries.map((entry) => entry.workspace.id), ["workspace-b", "workspace-a"]);
});

test("buildRepositoryWorktreeView all view mixes worktrees and shows repo badges", () => {
  const repoA = repository("repo-a", "Admin", 1);
  const repoB = repository("repo-b", "Api", 1);
  const old = project("old", 10, [binding(repoA.id, "/tmp/old")]);
  const recent = project("recent", 30, [binding(repoB.id, "/tmp/recent")]);

  const view = buildRepositoryWorktreeView({
    projects: [old, recent],
    repositories: [repoA, repoB],
    selectedRepositoryId: ALL_REPOSITORIES_FILTER_ID,
    dirtyByWorktree: {},
    statusByProject: {},
  });

  assert.deepEqual(view.entries.map((entry) => entry.workspace.id), ["recent", "old"]);
  assert.ok(view.entries.every((entry) => entry.showRepositoryBadge));
});

test("buildRepositoryWorktreeView filters selected repository rows", () => {
  const repoA = repository("repo-a", "Admin");
  const repoB = repository("repo-b", "Api");
  const admin = project("admin", 10, [binding(repoA.id, "/tmp/admin")]);
  const api = project("api", 20, [binding(repoB.id, "/tmp/api")]);

  const view = buildRepositoryWorktreeView({
    projects: [admin, api],
    repositories: [repoA, repoB],
    selectedRepositoryId: repoA.id,
    dirtyByWorktree: {},
    statusByProject: {},
  });

  assert.deepEqual(view.entries.map((entry) => entry.workspace.id), ["admin"]);
  assert.ok(view.entries.every((entry) => !entry.showRepositoryBadge));
});

test("buildRepositoryWorktreeView lists multi-repo workspace under each repo filter", () => {
  const repoA = repository("repo-a", "Admin");
  const repoB = repository("repo-b", "Api");
  const workspace = project("combo", 10, [
    binding(repoA.id, "/tmp/combo-admin"),
    binding(repoB.id, "/tmp/combo-api"),
  ]);

  const adminView = buildRepositoryWorktreeView({
    projects: [workspace],
    repositories: [repoA, repoB],
    selectedRepositoryId: repoA.id,
    dirtyByWorktree: {},
    statusByProject: {},
  });
  const apiView = buildRepositoryWorktreeView({
    projects: [workspace],
    repositories: [repoA, repoB],
    selectedRepositoryId: repoB.id,
    dirtyByWorktree: {},
    statusByProject: {},
  });

  assert.equal(adminView.entries[0]?.binding.repoId, repoA.id);
  assert.equal(apiView.entries[0]?.binding.repoId, repoB.id);
});

test("buildRepositoryWorktreeView tracks dirty and running indicators", () => {
  const repo = repository("repo-1", "Loom");
  const workspace = project("workspace", 10, [binding(repo.id, "/tmp/workspace")]);

  const view = buildRepositoryWorktreeView({
    projects: [workspace],
    repositories: [repo],
    selectedRepositoryId: ALL_REPOSITORIES_FILTER_ID,
    dirtyByWorktree: {
      [workspaceDirtyKey(workspace.id, repo.id, "/tmp/workspace")]: true,
    },
    statusByProject: { [workspace.id]: "running" },
  });

  const repoChip = view.chips.find((chip) => chip.id === repo.id);
  assert.equal(repoChip?.dirty, true);
  assert.equal(repoChip?.running, true);
  assert.equal(view.entries[0]?.dirty, true);
});

test("buildRepositoryWorktreeView allows selecting a repository before it has worktrees", () => {
  const repo = repository("repo-empty", "Empty");

  const view = buildRepositoryWorktreeView({
    projects: [],
    repositories: [repo],
    selectedRepositoryId: repo.id,
    dirtyByWorktree: {},
    statusByProject: {},
  });

  assert.equal(view.selectedRepositoryId, repo.id);
  assert.equal(view.chips.find((chip) => chip.id === repo.id)?.worktreeCount, 0);
  assert.deepEqual(view.entries, []);
});

test("parseWorkspaceSidebarViewMode falls back to status for invalid localStorage values", () => {
  assert.equal(parseWorkspaceSidebarViewMode("repository"), "repository");
  assert.equal(parseWorkspaceSidebarViewMode("status"), "status");
  assert.equal(parseWorkspaceSidebarViewMode("unknown"), "status");
  assert.equal(parseWorkspaceSidebarViewMode(null), "status");
});
