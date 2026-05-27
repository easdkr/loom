export type RepositoryKind = "local" | "cloned";

export type WorkspaceRepoBindingKind = "existing-root" | "worktree";

export type WorktreePolicy = "workspace" | "node-isolated";

export type LoomMode = "single" | "plan" | "auto";

export const DEFAULT_WORKSPACE_MODE: LoomMode = "plan";

export interface Repository {
  id: string;
  name: string;
  sourceRoot: string;
  remoteUrl?: string | null;
  defaultBranch: string;
  kind: RepositoryKind;
  createdAt: number;
  lastOpenedAt: number;
}

export interface WorkspaceRepoBinding {
  repoId: string;
  branch: string;
  worktreePath: string;
  bindingKind: WorkspaceRepoBindingKind;
}

export interface Workspace {
  id: string;
  name: string;
  repoBindings: WorkspaceRepoBinding[];
  activeRepoId: string;
  mode?: LoomMode;
  createdAt: number;
  lastOpenedAt: number;
}

export interface WorkspaceView extends Workspace {
  activeBinding: WorkspaceRepoBinding;
  activeRepository?: Repository;
  repoCount: number;
  root: string;
  repository?: Repository;
  displayBranch: string;
  displayPath: string;
  providersOverride?: string;
}

export interface Project extends WorkspaceView {}

export interface LegacyProject {
  id: string;
  root: string;
  name: string;
  providersOverride?: string;
  lastOpenedAt: number;
}

export interface WorkspaceRegistryV2 {
  version: 2;
  projects: LegacyProject[];
  openTabs: string[];
  activeTabId: string | null;
}

export interface WorkspaceRegistryV3 {
  version: 3;
  repositories: Repository[];
  workspaces: Workspace[];
  openTabs: string[];
  activeWorkspaceId: string | null;
}

export interface ProjectGraphPayloadV1<TNode = unknown, TEdge = unknown> {
  version: 1;
  nodes: TNode[];
  edges: TEdge[];
}

export function normalizeWorkspace(workspace: Workspace): Workspace {
  const activeBinding =
    workspace.repoBindings.find((binding) => binding.repoId === workspace.activeRepoId) ??
    workspace.repoBindings[0];
  return {
    ...workspace,
    activeRepoId: activeBinding?.repoId ?? workspace.activeRepoId,
    mode: workspace.mode ?? DEFAULT_WORKSPACE_MODE,
  };
}

export function createWorkspaceView(
  workspace: Workspace,
  repositories: Repository[],
): WorkspaceView | null {
  const normalized = normalizeWorkspace(workspace);
  const repositoriesById = new Map(
    repositories.map((repository) => [repository.id, repository]),
  );
  const activeBinding =
    normalized.repoBindings.find((binding) => binding.repoId === normalized.activeRepoId) ??
    normalized.repoBindings[0];
  if (!activeBinding) {
    return null;
  }
  const activeRepository = repositoriesById.get(activeBinding.repoId);
  return {
    ...normalized,
    activeRepoId: activeBinding.repoId,
    activeBinding,
    activeRepository,
    repository: activeRepository,
    repoCount: normalized.repoBindings.length,
    root: activeBinding.worktreePath,
    displayBranch: activeBinding.branch,
    displayPath: activeBinding.worktreePath,
  };
}
