import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { create } from "zustand";
import {
  basename,
  createProjectId,
  type Project,
  type WorkspaceRegistryV2,
} from "@core/index";

const EMPTY_REGISTRY: WorkspaceRegistryV2 = {
  version: 2,
  projects: [],
  openTabs: [],
  activeTabId: null,
};

const REGISTRY_SAVE_DELAY_MS = 300;

interface WorkspaceLoadResponse {
  path: string;
  payload: string | null;
}

interface NormalizeProjectRootResponse {
  root: string;
}

interface V1WorkspacePayload {
  version: 1;
  nodes: unknown[];
  edges: unknown[];
}

export interface WorkspaceState {
  projects: Project[];
  openTabs: string[];
  activeTabId: string | null;
  ready: boolean;
  error: string | null;

  initialize: () => Promise<void>;
  pickAndAddProject: () => Promise<Project | null>;
  addProjectRoot: (root: string) => Promise<Project>;
  openTab: (id: string) => void;
  closeTab: (id: string) => void;
  closeOtherTabs: (id: string) => void;
  removeProject: (id: string) => void;
  renameProject: (id: string, name: string) => void;
  reorderTabs: (nextOrder: string[]) => void;
  setActiveTab: (id: string) => void;
}

let saveTimer: number | null = null;

function registryFromState(state: WorkspaceState): WorkspaceRegistryV2 {
  return {
    version: 2,
    projects: state.projects,
    openTabs: state.openTabs,
    activeTabId: state.activeTabId,
  };
}

async function saveRegistry(registry: WorkspaceRegistryV2, backupV1 = false): Promise<void> {
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

function applyRegistry(registry: WorkspaceRegistryV2): Partial<WorkspaceState> {
  const projectIds = new Set(registry.projects.map((project) => project.id));
  const openTabs = registry.openTabs.filter((id) => projectIds.has(id));
  const activeTabId =
    registry.activeTabId && openTabs.includes(registry.activeTabId)
      ? registry.activeTabId
      : (openTabs[0] ?? null);
  return {
    projects: registry.projects,
    openTabs,
    activeTabId,
    ready: true,
    error: null,
  };
}

function parseRegistry(payload: string | null): WorkspaceRegistryV2 | V1WorkspacePayload {
  if (!payload) {
    return EMPTY_REGISTRY;
  }
  const parsed = JSON.parse(payload) as WorkspaceRegistryV2 | V1WorkspacePayload;
  if (parsed.version !== 1 && parsed.version !== 2) {
    throw new Error("unsupported workspace version");
  }
  return parsed;
}

async function normalizeProjectRoot(path: string): Promise<string> {
  return invoke<NormalizeProjectRootResponse>("normalize_project_root", {
    request: { root: path },
  })
    .then((response) => response.root)
    .catch(() => path);
}

async function pickProjectRoot(): Promise<string | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "프로젝트 폴더 선택",
  });
  return typeof selected === "string" ? selected : null;
}

async function migrateV1(payload: V1WorkspacePayload): Promise<WorkspaceRegistryV2> {
  const picked = await pickProjectRoot();
  if (!picked) {
    await saveRegistry(EMPTY_REGISTRY, true);
    return EMPTY_REGISTRY;
  }

  const root = await normalizeProjectRoot(picked);
  const project: Project = {
    id: createProjectId(),
    root,
    name: basename(root),
    lastOpenedAt: Date.now(),
  };
  await invoke<string>("project_graph_save", {
    request: { root, payload: JSON.stringify(payload) },
  });
  const registry: WorkspaceRegistryV2 = {
    version: 2,
    projects: [project],
    openTabs: [project.id],
    activeTabId: project.id,
  };
  await saveRegistry(registry, true);
  return registry;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  projects: [],
  openTabs: [],
  activeTabId: null,
  ready: false,
  error: null,

  initialize: async () => {
    try {
      const response = await invoke<WorkspaceLoadResponse>("workspace_load");
      const parsed = parseRegistry(response.payload);
      const registry = parsed.version === 1 ? await migrateV1(parsed) : parsed;
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
    const root = await normalizeProjectRoot(selectedRoot);
    const existing = get().projects.find((project) => project.root === root);
    if (existing) {
      get().openTab(existing.id);
      return existing;
    }

    const project: Project = {
      id: createProjectId(),
      root,
      name: basename(root),
      lastOpenedAt: Date.now(),
    };
    set((state) => ({
      projects: [...state.projects, project],
      openTabs: [...state.openTabs, project.id],
      activeTabId: project.id,
      error: null,
    }));
    scheduleRegistrySave(get);
    return project;
  },

  openTab: (id) => {
    set((state) => {
      const project = state.projects.find((item) => item.id === id);
      if (!project) {
        return state;
      }
      const openTabs = state.openTabs.includes(id) ? state.openTabs : [...state.openTabs, id];
      return {
        openTabs,
        activeTabId: id,
        projects: state.projects.map((item) =>
          item.id === id ? { ...item, lastOpenedAt: Date.now() } : item,
        ),
      };
    });
    scheduleRegistrySave(get);
  },

  closeTab: (id) => {
    set((state) => {
      const openTabs = state.openTabs.filter((tabId) => tabId !== id);
      const activeTabId =
        state.activeTabId === id ? (openTabs[0] ?? null) : state.activeTabId;
      return { openTabs, activeTabId };
    });
    scheduleRegistrySave(get);
  },

  closeOtherTabs: (id) => {
    set((state) => ({
      openTabs: state.openTabs.includes(id) ? [id] : [],
      activeTabId: state.openTabs.includes(id) ? id : null,
    }));
    scheduleRegistrySave(get);
  },

  removeProject: (id) => {
    set((state) => {
      const projects = state.projects.filter((project) => project.id !== id);
      const openTabs = state.openTabs.filter((tabId) => tabId !== id);
      return {
        projects,
        openTabs,
        activeTabId:
          state.activeTabId === id ? (openTabs[0] ?? null) : state.activeTabId,
      };
    });
    scheduleRegistrySave(get);
  },

  renameProject: (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }
    set((state) => ({
      projects: state.projects.map((project) =>
        project.id === id ? { ...project, name: trimmed } : project,
      ),
    }));
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
      return { openTabs: ordered };
    });
    scheduleRegistrySave(get);
  },

  setActiveTab: (id) => {
    set((state) => {
      if (!state.openTabs.includes(id)) {
        return state;
      }
      return {
        activeTabId: id,
        projects: state.projects.map((project) =>
          project.id === id ? { ...project, lastOpenedAt: Date.now() } : project,
        ),
      };
    });
    scheduleRegistrySave(get);
  },
}));

export function getActiveProject(): Project | null {
  const state = useWorkspaceStore.getState();
  return state.projects.find((project) => project.id === state.activeTabId) ?? null;
}
