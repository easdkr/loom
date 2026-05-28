import type { Project, Repository, WorkspaceRepoBinding } from "@core/index";
import type { WorkspaceDerivedStatus } from "@stores/workspaceStatus";

export const WORKSPACE_STATUS_ORDER: WorkspaceDerivedStatus[] = [
  "review",
  "running",
  "error",
  "idle",
  "complete",
];

export const WORKSPACE_STATUS_LABEL: Record<WorkspaceDerivedStatus, string> = {
  review: "Review",
  running: "Running",
  error: "Failed",
  idle: "Idle",
  complete: "Done",
};

export interface WorkspaceStatusEntry {
  project: Project;
  status: WorkspaceDerivedStatus;
}

export type WorkspaceSidebarViewMode = "status" | "repository";

export const WORKSPACE_SIDEBAR_VIEW_STORAGE_KEY = "loom.workspaceSidebar.view";
export const ALL_REPOSITORIES_FILTER_ID = "all";

export interface RepositoryWorktreeEntry {
  workspace: Project;
  binding: WorkspaceRepoBinding;
  repository?: Repository;
  status: WorkspaceDerivedStatus;
  dirty: boolean;
  showRepositoryBadge: boolean;
}

export interface RepositoryFilterChip {
  id: string;
  label: string;
  worktreeCount: number;
  dirty: boolean;
  running: boolean;
  lastActivityAt: number;
}

export interface RepositoryWorktreeView {
  selectedRepositoryId: string;
  chips: RepositoryFilterChip[];
  entries: RepositoryWorktreeEntry[];
}

export function groupWorkspaceEntries(entries: WorkspaceStatusEntry[]): WorkspaceStatusEntry[][] {
  return WORKSPACE_STATUS_ORDER.map((status) =>
    entries
      .filter((entry) => entry.status === status)
      .sort((a, b) => b.project.lastOpenedAt - a.project.lastOpenedAt),
  );
}

export function parseWorkspaceSidebarViewMode(value: string | null): WorkspaceSidebarViewMode {
  return value === "repository" ? "repository" : "status";
}

export function workspaceDirtyKey(workspaceId: string, repoId: string, worktreePath: string): string {
  return `${workspaceId}\u0000${repoId}\u0000${worktreePath}`;
}

export function buildRepositoryWorktreeView({
  projects,
  repositories,
  selectedRepositoryId,
  dirtyByWorktree,
  statusByProject,
}: {
  projects: Project[];
  repositories: Repository[];
  selectedRepositoryId: string;
  dirtyByWorktree: Record<string, boolean>;
  statusByProject: Record<string, WorkspaceDerivedStatus>;
}): RepositoryWorktreeView {
  const repositoriesById = new Map(repositories.map((repository) => [repository.id, repository]));
  const allEntries = projects
    .flatMap((workspace) => {
      const status = statusByProject[workspace.id] ?? "idle";
      return workspace.repoBindings.map((binding) => ({
        workspace,
        binding,
        repository: repositoriesById.get(binding.repoId),
        status,
        dirty: Boolean(dirtyByWorktree[workspaceDirtyKey(workspace.id, binding.repoId, binding.worktreePath)]),
        showRepositoryBadge: selectedRepositoryId === ALL_REPOSITORIES_FILTER_ID,
      }));
    })
    .sort((a, b) => b.workspace.lastOpenedAt - a.workspace.lastOpenedAt);

  const knownRepositoryIds = new Set(repositories.map((repository) => repository.id));
  const boundRepositoryIds = new Set(allEntries.map((entry) => entry.binding.repoId));
  const effectiveSelectedRepositoryId =
    selectedRepositoryId === ALL_REPOSITORIES_FILTER_ID ||
    knownRepositoryIds.has(selectedRepositoryId) ||
    boundRepositoryIds.has(selectedRepositoryId)
      ? selectedRepositoryId
      : ALL_REPOSITORIES_FILTER_ID;

  const allChip: RepositoryFilterChip = {
    id: ALL_REPOSITORIES_FILTER_ID,
    label: "All",
    worktreeCount: allEntries.length,
    dirty: allEntries.some((entry) => entry.dirty),
    running: allEntries.some((entry) => entry.status === "running" || entry.status === "review"),
    lastActivityAt: allEntries[0]?.workspace.lastOpenedAt ?? 0,
  };

  const repoChips = Array.from(new Set([...repositories.map((item) => item.id), ...boundRepositoryIds]))
    .filter((repoId) => knownRepositoryIds.has(repoId) || boundRepositoryIds.has(repoId))
    .map((repoId) => {
      const entries = allEntries.filter((entry) => entry.binding.repoId === repoId);
      const repository = repositoriesById.get(repoId);
      return {
        id: repoId,
        label: repository?.name ?? repoId,
        worktreeCount: entries.length,
        dirty: entries.some((entry) => entry.dirty),
        running: entries.some((entry) => entry.status === "running" || entry.status === "review"),
        lastActivityAt: entries[0]?.workspace.lastOpenedAt ?? repository?.lastOpenedAt ?? 0,
      };
    })
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt);

  const entries =
    effectiveSelectedRepositoryId === ALL_REPOSITORIES_FILTER_ID
      ? allEntries
      : allEntries.filter((entry) => entry.binding.repoId === effectiveSelectedRepositoryId);

  return {
    selectedRepositoryId: effectiveSelectedRepositoryId,
    chips: [allChip, ...repoChips],
    entries: entries.map((entry) => ({
      ...entry,
      showRepositoryBadge: effectiveSelectedRepositoryId === ALL_REPOSITORIES_FILTER_ID,
    })),
  };
}
