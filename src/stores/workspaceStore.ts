import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { create, type StoreApi, type UseBoundStore } from "zustand";
import {
  basename,
  createProjectId,
  type LegacyProject,
  type Project,
  type Repository,
  type Workspace,
  type WorkspaceRegistryV2,
  type WorkspaceRegistryV3,
} from "@core/index";

const EMPTY_REGISTRY: WorkspaceRegistryV3 = {
  version: 3,
  repositories: [],
  workspaces: [],
  openTabs: [],
  activeWorkspaceId: null,
};

const REGISTRY_SAVE_DELAY_MS = 300;

interface WorkspaceLoadResponse {
  path: string;
  payload: string | null;
}

interface V1WorkspacePayload {
  version: 1;
  nodes: unknown[];
  edges: unknown[];
}

interface WorkspaceCreateResponse {
  registry: WorkspaceRegistryV3;
}

interface WorkspaceRemoveResponse {
  registry: WorkspaceRegistryV3;
}

type ParsedWorkspace = V1WorkspacePayload | WorkspaceRegistryV2 | WorkspaceRegistryV3;

export interface WorkspaceState {
  repositories: Repository[];
  workspaces: Workspace[];
  projects: Project[];
  openTabs: string[];
  activeTabId: string | null;
  ready: boolean;
  error: string | null;

  initialize: () => Promise<void>;
  pickAndAddProject: () => Promise<Project | null>;
  addProjectRoot: (root: string) => Promise<Project>;
  registerLocalRepository: (root: string) => Promise<Repository>;
  cloneRepository: (url: string, name?: string) => Promise<Project>;
  createWorkspace: (name: string, repoIds: string[], baseRef?: string) => Promise<Project>;
  openTab: (id: string) => void;
  closeTab: (id: string) => void;
  closeOtherTabs: (id: string) => void;
  removeProject: (id: string) => void;
  removeWorkspace: (id: string, force?: boolean) => Promise<void>;
  renameProject: (id: string, name: string) => void;
  reorderTabs: (nextOrder: string[]) => void;
  setActiveTab: (id: string) => void;
}

let saveTimer: number | null = null;

function registryFromState(state: WorkspaceState): WorkspaceRegistryV3 {
  return {
    version: 3,
    repositories: state.repositories,
    workspaces: state.workspaces,
    openTabs: state.openTabs,
    activeWorkspaceId: state.activeTabId,
  };
}

async function saveRegistry(registry: WorkspaceRegistryV3, backupV1 = false): Promise<void> {
  await invoke<string>("workspace_save", {
    request: { payload: JSON.stringify(registry), backup_v1: backupV1 },
  });
}

function scheduleRegistrySave(get: () => WorkspaceState): void {
  if (saveTimer !== null) {
    window.clearTimeout(saveTimer);
  }
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    void saveRegistry(registryFromState(get())).catch((error) => {
      useWorkspaceStore.setState({ error: String(error) });
    });
  }, REGISTRY_SAVE_DELAY_MS);
}

function projectViews(registry: WorkspaceRegistryV3): Project[] {
  const repositoriesById = new Map(
    registry.repositories.map((repository) => [repository.id, repository]),
  );
  const projects: Project[] = [];
  for (const workspace of registry.workspaces) {
    const activeBinding =
      workspace.repoBindings.find((binding) => binding.repoId === workspace.activeRepoId) ??
      workspace.repoBindings[0];
    if (!activeBinding) {
      continue;
    }
    projects.push({
      ...workspace,
      activeRepoId: activeBinding.repoId,
      root: activeBinding.worktreePath,
      repository: repositoriesById.get(activeBinding.repoId),
    });
  }
  return projects;
}

function applyRegistry(registry: WorkspaceRegistryV3): Partial<WorkspaceState> {
  const workspaceIds = new Set(registry.workspaces.map((workspace) => workspace.id));
  const openTabs = registry.openTabs.filter((id) => workspaceIds.has(id));
  const activeTabId =
    registry.activeWorkspaceId && openTabs.includes(registry.activeWorkspaceId)
      ? registry.activeWorkspaceId
      : (openTabs[0] ?? null);
  const normalized = {
    ...registry,
    openTabs,
    activeWorkspaceId: activeTabId,
  };
  return {
    repositories: normalized.repositories,
    workspaces: normalized.workspaces,
    projects: projectViews(normalized),
    openTabs,
    activeTabId,
    ready: true,
    error: null,
  };
}

function parseRegistry(payload: string | null): ParsedWorkspace {
  if (!payload) {
    return EMPTY_REGISTRY;
  }
  const parsed = JSON.parse(payload) as ParsedWorkspace;
  if (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3) {
    throw new Error("unsupported workspace version");
  }
  return parsed;
}

async function pickProjectRoot(): Promise<string | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Repository folder",
  });
  return typeof selected === "string" ? selected : null;
}

function legacyProjectToV3(project: LegacyProject): {
  repository: Repository;
  workspace: Workspace;
} {
  const now = Date.now();
  const repoId = `repo_${project.id}`;
  const repository: Repository = {
    id: repoId,
    name: project.name,
    sourceRoot: project.root,
    remoteUrl: null,
    defaultBranch: "main",
    kind: "local",
    createdAt: project.lastOpenedAt || now,
    lastOpenedAt: project.lastOpenedAt || now,
  };
  const workspace: Workspace = {
    id: project.id,
    name: project.name,
    repoBindings: [
      {
        repoId,
        branch: repository.defaultBranch,
        worktreePath: project.root,
        bindingKind: "existing-root",
      },
    ],
    activeRepoId: repoId,
    createdAt: project.lastOpenedAt || now,
    lastOpenedAt: project.lastOpenedAt || now,
  };
  return { repository, workspace };
}

function uniqueWorkspaceName(baseName: string, workspaces: Workspace[]): string {
  const cleanName = baseName.trim() || "workspace";
  const names = new Set(workspaces.map((workspace) => workspace.name));
  if (!names.has(cleanName)) {
    return cleanName;
  }
  let index = 2;
  let candidate = `${cleanName} ${index}`;
  while (names.has(candidate)) {
    index += 1;
    candidate = `${cleanName} ${index}`;
  }
  return candidate;
}

async function migrateV1(payload: V1WorkspacePayload): Promise<WorkspaceRegistryV3> {
  const picked = await pickProjectRoot();
  if (!picked) {
    await saveRegistry(EMPTY_REGISTRY, true);
    return EMPTY_REGISTRY;
  }

  const now = Date.now();
  const repoId = createProjectId();
  const workspaceId = createProjectId();
  const repository: Repository = {
    id: repoId,
    name: basename(picked),
    sourceRoot: picked,
    remoteUrl: null,
    defaultBranch: "main",
    kind: "local",
    createdAt: now,
    lastOpenedAt: now,
  };
  const workspace: Workspace = {
    id: workspaceId,
    name: repository.name,
    repoBindings: [
      {
        repoId,
        branch: repository.defaultBranch,
        worktreePath: picked,
        bindingKind: "existing-root",
      },
    ],
    activeRepoId: repoId,
    createdAt: now,
    lastOpenedAt: now,
  };
  await invoke<string>("workspace_graph_save", {
    request: { workspace_id: workspace.id, payload: JSON.stringify(payload) },
  });
  const registry: WorkspaceRegistryV3 = {
    version: 3,
    repositories: [repository],
    workspaces: [workspace],
    openTabs: [workspace.id],
    activeWorkspaceId: workspace.id,
  };
  await saveRegistry(registry, true);
  return registry;
}

async function migrateV2(registry: WorkspaceRegistryV2): Promise<WorkspaceRegistryV3> {
  const migrated = registry.projects.map(legacyProjectToV3);
  const workspaceIds = new Set(migrated.map((item) => item.workspace.id));
  const openTabs = registry.openTabs.filter((id) => workspaceIds.has(id));
  const activeWorkspaceId =
    registry.activeTabId && openTabs.includes(registry.activeTabId)
      ? registry.activeTabId
      : (openTabs[0] ?? null);
  const next: WorkspaceRegistryV3 = {
    version: 3,
    repositories: migrated.map((item) => item.repository),
    workspaces: migrated.map((item) => item.workspace),
    openTabs,
    activeWorkspaceId,
  };
  await saveRegistry(next);
  return next;
}

function upsertRepository(repositories: Repository[], repository: Repository): Repository[] {
  const existing = repositories.find(
    (item) => item.id === repository.id || item.sourceRoot === repository.sourceRoot,
  );
  if (!existing) {
    return [...repositories, repository];
  }
  return repositories.map((item) =>
    item.id === existing.id ? { ...repository, id: existing.id } : item,
  );
}

export const useWorkspaceStore: UseBoundStore<StoreApi<WorkspaceState>> = create<WorkspaceState>((set, get) => ({
  repositories: [],
  workspaces: [],
  projects: [],
  openTabs: [],
  activeTabId: null,
  ready: false,
  error: null,

  initialize: async () => {
    try {
      const response = await invoke<WorkspaceLoadResponse>("workspace_load");
      const parsed = parseRegistry(response.payload);
      const registry =
        parsed.version === 1
          ? await migrateV1(parsed)
          : parsed.version === 2
            ? await migrateV2(parsed)
            : parsed;
      set(applyRegistry(registry));
    } catch (error) {
      set({ ...applyRegistry(EMPTY_REGISTRY), error: String(error) });
    }
  },

  pickAndAddProject: async () => {
    const picked = await pickProjectRoot();
    if (!picked) {
      return null;
    }
    return get().addProjectRoot(picked);
  },

  addProjectRoot: async (selectedRoot) => {
    const repository = await get().registerLocalRepository(selectedRoot);
    return get().createWorkspace(
      uniqueWorkspaceName(repository.name, get().workspaces),
      [repository.id],
    );
  },

  registerLocalRepository: async (root) => {
    const repository = await invoke<Repository>("repo_register_local", {
      request: { root },
    });
    const existing = get().repositories.find(
      (item) => item.sourceRoot === repository.sourceRoot,
    );
    const effective = existing ? { ...repository, id: existing.id } : repository;
    set((state) => {
      const repositories = upsertRepository(state.repositories, effective);
      const registry = registryFromState({ ...state, repositories });
      return {
        repositories,
        projects: projectViews(registry),
        error: null,
      };
    });
    await saveRegistry(registryFromState(get()));
    return effective;
  },

  cloneRepository: async (url, name) => {
    const repository = await invoke<Repository>("repo_clone", {
      request: { url, name: name?.trim() || null },
    });
    set((state) => {
      const repositories = upsertRepository(state.repositories, repository);
      const registry = registryFromState({ ...state, repositories });
      return {
        repositories,
        projects: projectViews(registry),
        error: null,
      };
    });
    await saveRegistry(registryFromState(get()));
    return get().createWorkspace(
      uniqueWorkspaceName(repository.name, get().workspaces),
      [repository.id],
    );
  },

  createWorkspace: async (name, repoIds, baseRef) => {
    if (repoIds.length === 0) {
      throw new Error("workspace requires at least one repository");
    }
    const response = await invoke<WorkspaceCreateResponse>("workspace_create", {
      request: {
        name,
        repo_ids: repoIds,
        base_ref: baseRef ?? null,
        repositories: get().repositories,
      },
    });
    set(applyRegistry(response.registry));
    const created = get().projects.find(
      (project) => project.id === response.registry.activeWorkspaceId,
    );
    if (!created) {
      throw new Error("workspace_create did not return an active workspace");
    }
    return created;
  },

  openTab: (id) => {
    set((state) => {
      const workspace = state.workspaces.find((item) => item.id === id);
      if (!workspace) {
        return state;
      }
      const openTabs = state.openTabs.includes(id) ? state.openTabs : [...state.openTabs, id];
      const workspaces = state.workspaces.map((item) =>
        item.id === id ? { ...item, lastOpenedAt: Date.now() } : item,
      );
      const registry = registryFromState({
        ...state,
        workspaces,
        openTabs,
        activeTabId: id,
      });
      return {
        workspaces,
        openTabs,
        activeTabId: id,
        projects: projectViews(registry),
      };
    });
    scheduleRegistrySave(get);
  },

  closeTab: (id) => {
    set((state) => {
      const openTabs = state.openTabs.filter((tabId) => tabId !== id);
      const activeTabId =
        state.activeTabId === id ? (openTabs[0] ?? null) : state.activeTabId;
      const registry = registryFromState({ ...state, openTabs, activeTabId });
      return { openTabs, activeTabId, projects: projectViews(registry) };
    });
    scheduleRegistrySave(get);
  },

  closeOtherTabs: (id) => {
    set((state) => {
      const openTabs = state.openTabs.includes(id) ? [id] : [];
      const activeTabId = state.openTabs.includes(id) ? id : null;
      const registry = registryFromState({ ...state, openTabs, activeTabId });
      return { openTabs, activeTabId, projects: projectViews(registry) };
    });
    scheduleRegistrySave(get);
  },

  removeProject: (id) => {
    set((state) => {
      const workspaces = state.workspaces.filter((workspace) => workspace.id !== id);
      const openTabs = state.openTabs.filter((tabId) => tabId !== id);
      const activeTabId =
        state.activeTabId === id ? (openTabs[0] ?? null) : state.activeTabId;
      const registry = registryFromState({ ...state, workspaces, openTabs, activeTabId });
      return {
        workspaces,
        openTabs,
        activeTabId,
        projects: projectViews(registry),
      };
    });
    scheduleRegistrySave(get);
  },

  removeWorkspace: async (id, force = false) => {
    const response = await invoke<WorkspaceRemoveResponse>("workspace_remove", {
      request: { workspace_id: id, force },
    });
    set(applyRegistry(response.registry));
  },

  renameProject: (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }
    set((state) => {
      const workspaces = state.workspaces.map((workspace) =>
        workspace.id === id ? { ...workspace, name: trimmed } : workspace,
      );
      const registry = registryFromState({ ...state, workspaces });
      return {
        workspaces,
        projects: projectViews(registry),
      };
    });
    scheduleRegistrySave(get);
  },

  reorderTabs: (nextOrder) => {
    set((state) => {
      const current = new Set(state.openTabs);
      const ordered = nextOrder.filter((id) => current.has(id));
      for (const id of state.openTabs) {
        if (!ordered.includes(id)) {
          ordered.push(id);
        }
      }
      const registry = registryFromState({ ...state, openTabs: ordered });
      return { openTabs: ordered, projects: projectViews(registry) };
    });
    scheduleRegistrySave(get);
  },

  setActiveTab: (id) => {
    set((state) => {
      if (!state.openTabs.includes(id)) {
        return state;
      }
      const workspaces = state.workspaces.map((workspace) =>
        workspace.id === id ? { ...workspace, lastOpenedAt: Date.now() } : workspace,
      );
      const registry = registryFromState({
        ...state,
        workspaces,
        activeTabId: id,
      });
      return {
        activeTabId: id,
        workspaces,
        projects: projectViews(registry),
      };
    });
    scheduleRegistrySave(get);
  },
}));

export function getActiveProject(): Project | null {
  const state = useWorkspaceStore.getState();
  return state.projects.find((project) => project.id === state.activeTabId) ?? null;
}
