export type RepositoryKind = "local" | "cloned";

export type WorkspaceRepoBindingKind = "existing-root" | "worktree";

export type WorktreePolicy = "workspace" | "node-isolated";

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
  createdAt: number;
  lastOpenedAt: number;
}

export interface Project extends Workspace {
  root: string;
  repository?: Repository;
  providersOverride?: string;
}

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
