import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { useWorkspaceStore } from "./workspaceStore";

export type ExecutionStatus =
  | "idle"
  | "queued"
  | "running"
  | "complete"
  | "error"
  | "skipped";

export interface NodeExecution {
  status: ExecutionStatus;
  startedAt?: number;
  completedAt?: number;
  exitCode?: number | null;
  completionReason?: string;
  error?: string;
  truncated?: boolean;
  errorClass?: "rate-limit" | "provider-error" | null;
}

export interface ExecutionState {
  runId: string | null;
  perNode: Record<string, NodeExecution>;
  activeNodeIds: string[];
  outputByNode: Record<string, string>;

  beginRun: (runId: string, nodeIds: string[]) => void;
  setStatus: (nodeId: string, patch: Partial<NodeExecution>) => void;
  setActive: (nodeIds: string[]) => void;
  appendOutput: (nodeId: string, chunk: string) => void;
  clearOutput: (nodeId?: string) => void;
  clear: () => void;
}

type ExecutionStoreApi = StoreApi<ExecutionState>;

const MAX_OUTPUT_CHARS = 200_000;

function trimOutput(value: string): string {
  return value.length > MAX_OUTPUT_CHARS ? value.slice(value.length - MAX_OUTPUT_CHARS) : value;
}

function createExecutionStore(): ExecutionStoreApi {
  return createStore<ExecutionState>((set) => ({
  runId: null,
  perNode: {},
  activeNodeIds: [],
  outputByNode: {},

  beginRun: (runId, nodeIds) => {
    const perNode: Record<string, NodeExecution> = {};
    for (const id of nodeIds) {
      perNode[id] = { status: "queued" };
    }
    set({ runId, perNode, activeNodeIds: [], outputByNode: {} });
  },
  setStatus: (nodeId, patch) =>
    set((state) => ({
      perNode: {
        ...state.perNode,
        [nodeId]: { ...(state.perNode[nodeId] ?? { status: "idle" }), ...patch },
      },
    })),
  setActive: (nodeIds) => set({ activeNodeIds: nodeIds }),
  appendOutput: (nodeId, chunk) =>
    set((state) => ({
      outputByNode: {
        ...state.outputByNode,
        [nodeId]: trimOutput(`${state.outputByNode[nodeId] ?? ""}${chunk}`),
      },
    })),
  clearOutput: (nodeId) =>
    set((state) => {
      if (!nodeId) {
        return { outputByNode: {} };
      }
      const next = { ...state.outputByNode };
      delete next[nodeId];
      return { outputByNode: next };
    }),
  clear: () => set({ runId: null, perNode: {}, activeNodeIds: [], outputByNode: {} }),
  }));
}

const emptyExecutionStore = createExecutionStore();
const executionStores = new Map<string, ExecutionStoreApi>();

export function getExecutionStore(projectId: string): ExecutionStoreApi {
  let store = executionStores.get(projectId);
  if (!store) {
    store = createExecutionStore();
    executionStores.set(projectId, store);
  }
  return store;
}

export function disposeExecutionStore(projectId: string): void {
  executionStores.delete(projectId);
}

function getActiveExecutionStore(): ExecutionStoreApi {
  const activeId = useWorkspaceStore.getState().activeTabId;
  return activeId ? getExecutionStore(activeId) : emptyExecutionStore;
}

export const useExecutionStore = Object.assign(
  function useExecutionStoreSelector<T>(selector: (state: ExecutionState) => T): T {
    const activeId = useWorkspaceStore((state) => state.activeTabId);
    const store = activeId ? getExecutionStore(activeId) : emptyExecutionStore;
    return useStore(store, selector);
  },
  {
    getState: () => getActiveExecutionStore().getState(),
    setState: (...args: Parameters<ExecutionStoreApi["setState"]>) =>
      getActiveExecutionStore().setState(...args),
  },
);

export function useProjectExecutionStatus(projectId: string): ExecutionStatus {
  return useStore(getExecutionStore(projectId), (state) => {
    const executions = Object.values(state.perNode);
    if (state.activeNodeIds.length > 0 || executions.some((item) => item.status === "running")) {
      return "running";
    }
    if (executions.some((item) => item.status === "error")) {
      return "error";
    }
    if (executions.some((item) => item.status === "complete")) {
      return "complete";
    }
    return "idle";
  });
}
