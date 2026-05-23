import { create } from "zustand";

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
}

interface ExecutionState {
  runId: string | null;
  perNode: Record<string, NodeExecution>;
  activeNodeIds: string[];

  beginRun: (runId: string, nodeIds: string[]) => void;
  setStatus: (nodeId: string, patch: Partial<NodeExecution>) => void;
  setActive: (nodeIds: string[]) => void;
  clear: () => void;
}

export const useExecutionStore = create<ExecutionState>((set) => ({
  runId: null,
  perNode: {},
  activeNodeIds: [],

  beginRun: (runId, nodeIds) => {
    const perNode: Record<string, NodeExecution> = {};
    for (const id of nodeIds) {
      perNode[id] = { status: "queued" };
    }
    set({ runId, perNode, activeNodeIds: [] });
  },
  setStatus: (nodeId, patch) =>
    set((state) => ({
      perNode: {
        ...state.perNode,
        [nodeId]: { ...(state.perNode[nodeId] ?? { status: "idle" }), ...patch },
      },
    })),
  setActive: (nodeIds) => set({ activeNodeIds: nodeIds }),
  clear: () => set({ runId: null, perNode: {}, activeNodeIds: [] }),
}));
