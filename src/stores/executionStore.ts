import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { useWorkspaceStore } from "./workspaceStore";
import {
  appendSystemMessage,
  createUserTranscript,
  sanitizeTranscriptText,
  type ExecutionTranscriptMessage,
  type ExecutionTranscriptStatus,
} from "./executionTranscript";

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
  transcriptByNode: Record<string, ExecutionTranscriptMessage[]>;
  activityByNode: Record<string, string | undefined>;

  beginRun: (runId: string, nodeIds: string[]) => void;
  setStatus: (nodeId: string, patch: Partial<NodeExecution>) => void;
  setActive: (nodeIds: string[]) => void;
  appendOutput: (nodeId: string, chunk: string) => void;
  beginTranscript: (nodeId: string, prompt: string) => void;
  appendUserMessage: (nodeId: string, text: string) => Promise<void>;
  applyAgentTranscript: (nodeId: string, assistantContent: string, activity?: string) => void;
  completeTranscript: (nodeId: string, statusText: string) => Promise<void>;
  failTranscript: (nodeId: string, errorText: string) => Promise<void>;
  clearOutput: (nodeId?: string) => void;
  clearTranscript: (nodeId?: string) => void;
  clear: () => void;
}

type ExecutionStoreApi = StoreApi<ExecutionState>;

const MAX_OUTPUT_CHARS = 200_000;

function trimOutput(value: string): string {
  return value.length > MAX_OUTPUT_CHARS ? value.slice(value.length - MAX_OUTPUT_CHARS) : value;
}

interface AgentTurn {
  userPrompt: string;
  assistantContent: string;
  baselineAssistantContent: string;
}

interface AgentSession {
  turns: AgentTurn[];
  renderedAssistantContent: string;
  status: ExecutionTranscriptStatus;
  statusText?: string;
  errorText?: string;
}

function createExecutionStore(): ExecutionStoreApi {
  const sessions = new Map<string, AgentSession>();

  function disposeSession(nodeId: string): void {
    sessions.delete(nodeId);
  }

  function disposeAllSessions(): void {
    for (const nodeId of Array.from(sessions.keys())) {
      disposeSession(nodeId);
    }
  }

  function buildTranscript(session: AgentSession): ExecutionTranscriptMessage[] {
    const messages: ExecutionTranscriptMessage[] = [];
    session.turns.forEach((turn, index) => {
      const cleanedPrompt = sanitizeTranscriptText(turn.userPrompt).trim();
      if (cleanedPrompt) {
        messages.push({
          id: `user-${messages.length}`,
          role: "user",
          content: cleanedPrompt,
          status: "complete",
        });
      }

      const assistantContent = sanitizeTranscriptText(turn.assistantContent).trim();
      const isLatestTurn = index === session.turns.length - 1;
      if (assistantContent && !(isLatestTurn && session.status === "running")) {
        messages.push({
          id: `assistant-${messages.length}`,
          role: "assistant",
          content: assistantContent,
          status: isLatestTurn ? session.status : "complete",
        });
      }
    });

    const systemText = session.errorText ?? session.statusText;
    if (systemText?.trim()) {
      messages.push({
        id: `system-${messages.length}`,
        role: "system",
        content: sanitizeTranscriptText(systemText).trim(),
        status: session.errorText ? "error" : session.status,
      });
    }

    return messages;
  }

  function activeTurn(session: AgentSession): AgentTurn | undefined {
    return session.turns[session.turns.length - 1];
  }

  function deriveTurnAssistantContent(
    renderedAssistantContent: string,
    baselineAssistantContent: string,
    userPrompt: string,
  ): string {
    const rendered = sanitizeTranscriptText(renderedAssistantContent).trim();
    const baseline = sanitizeTranscriptText(baselineAssistantContent).trim();
    const prompt = sanitizeTranscriptText(userPrompt).trim();
    const withoutBaseline = (() => {
      if (!baseline) {
        return rendered;
      }
      if (rendered === baseline) {
        return "";
      }
      if (rendered.startsWith(baseline)) {
        return rendered.slice(baseline.length).trim();
      }
      return rendered;
    })();

    if (!prompt || !withoutBaseline) {
      return withoutBaseline;
    }

    if (withoutBaseline === prompt) {
      return "";
    }

    if (withoutBaseline.startsWith(`${prompt}\n`)) {
      return withoutBaseline.slice(prompt.length).trim();
    }

    if (withoutBaseline.startsWith(`${prompt}\r\n`)) {
      return withoutBaseline.slice(prompt.length).trim();
    }

    return withoutBaseline;
  }

  return createStore<ExecutionState>((set) => ({
    runId: null,
    perNode: {},
    activeNodeIds: [],
    outputByNode: {},
    transcriptByNode: {},
    activityByNode: {},

    beginRun: (runId, nodeIds) => {
      disposeAllSessions();
      const perNode: Record<string, NodeExecution> = {};
      for (const id of nodeIds) {
        perNode[id] = { status: "queued" };
      }
      set({
        runId,
        perNode,
        activeNodeIds: [],
        outputByNode: {},
        transcriptByNode: {},
        activityByNode: {},
      });
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
    beginTranscript: (nodeId, prompt) => {
      disposeSession(nodeId);
      const session: AgentSession = {
        turns: [{ userPrompt: prompt, assistantContent: "", baselineAssistantContent: "" }],
        renderedAssistantContent: "",
        status: "running",
      };
      sessions.set(nodeId, session);
      const messages = createUserTranscript(prompt);
      set((state) => ({
        transcriptByNode: {
          ...state.transcriptByNode,
          [nodeId]: messages,
        },
        activityByNode: {
          ...state.activityByNode,
          [nodeId]: undefined,
        },
      }));
    },
    appendUserMessage: (nodeId, text) => {
      const session = sessions.get(nodeId);
      const cleaned = sanitizeTranscriptText(text).trim();
      if (!session || !cleaned) {
        return Promise.resolve();
      }
      const turn = activeTurn(session);
      if (turn && session.status === "running" && !turn.assistantContent.trim()) {
        turn.assistantContent = deriveTurnAssistantContent(
          session.renderedAssistantContent,
          turn.baselineAssistantContent,
          turn.userPrompt,
        );
      }
      session.turns.push({
        userPrompt: cleaned,
        assistantContent: "",
        baselineAssistantContent: session.renderedAssistantContent,
      });
      set((state) => ({
        transcriptByNode: {
          ...state.transcriptByNode,
          [nodeId]: buildTranscript(session),
        },
      }));
      return Promise.resolve();
    },
    applyAgentTranscript: (nodeId, assistantContent, activity) => {
      const session = sessions.get(nodeId) ?? {
        turns: [],
        renderedAssistantContent: "",
        status: "running" as const,
      };
      session.renderedAssistantContent = sanitizeTranscriptText(assistantContent).trim();
      let turn = activeTurn(session);
      if (!turn) {
        turn = {
          userPrompt: "",
          assistantContent: "",
          baselineAssistantContent: "",
        };
        session.turns.push(turn);
      }
      turn.assistantContent = deriveTurnAssistantContent(
        assistantContent,
        turn.baselineAssistantContent,
        turn.userPrompt,
      );
      sessions.set(nodeId, session);
      set((state) => ({
        transcriptByNode: {
          ...state.transcriptByNode,
          [nodeId]: buildTranscript(session),
        },
        activityByNode: {
          ...state.activityByNode,
          [nodeId]: session.status === "running" ? activity : undefined,
        },
      }));
    },
    completeTranscript: (nodeId, statusText) => {
      const session = sessions.get(nodeId);
      if (!session) {
        set((state) => ({
          transcriptByNode: {
            ...state.transcriptByNode,
            [nodeId]: appendSystemMessage(
              state.transcriptByNode[nodeId] ?? [],
              "complete",
              statusText,
            ),
          },
          activityByNode: {
            ...state.activityByNode,
            [nodeId]: undefined,
          },
        }));
        return Promise.resolve();
      }
      session.status = "complete";
      session.statusText = statusText;
      set((state) => ({
        transcriptByNode: {
          ...state.transcriptByNode,
          [nodeId]: buildTranscript(session),
        },
        activityByNode: {
          ...state.activityByNode,
          [nodeId]: undefined,
        },
      }));
      return Promise.resolve();
    },
    failTranscript: (nodeId, errorText) => {
      const session = sessions.get(nodeId);
      const cleaned = sanitizeTranscriptText(errorText).trim();
      if (!session) {
        set((state) => ({
          transcriptByNode: {
            ...state.transcriptByNode,
            [nodeId]: appendSystemMessage(
              state.transcriptByNode[nodeId] ?? [],
              "error",
              cleaned,
            ),
          },
          activityByNode: {
            ...state.activityByNode,
            [nodeId]: undefined,
          },
        }));
        return Promise.resolve();
      }
      session.status = "error";
      session.errorText = cleaned;
      set((state) => ({
        transcriptByNode: {
          ...state.transcriptByNode,
          [nodeId]: buildTranscript(session),
        },
        activityByNode: {
          ...state.activityByNode,
          [nodeId]: undefined,
        },
      }));
      return Promise.resolve();
    },
    clearOutput: (nodeId) =>
      set((state) => {
        if (!nodeId) {
          return { outputByNode: {} };
        }
        const next = { ...state.outputByNode };
        delete next[nodeId];
        return { outputByNode: next };
      }),
    clearTranscript: (nodeId) =>
      set((state) => {
        if (!nodeId) {
          disposeAllSessions();
          return { transcriptByNode: {}, activityByNode: {} };
        }
        disposeSession(nodeId);
        const nextTranscriptByNode = { ...state.transcriptByNode };
        const nextActivityByNode = { ...state.activityByNode };
        delete nextTranscriptByNode[nodeId];
        delete nextActivityByNode[nodeId];
        return { transcriptByNode: nextTranscriptByNode, activityByNode: nextActivityByNode };
      }),
    clear: () => {
      disposeAllSessions();
      set({
        runId: null,
        perNode: {},
        activeNodeIds: [],
        outputByNode: {},
        transcriptByNode: {},
        activityByNode: {},
      });
    },
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
  const store = executionStores.get(projectId);
  if (store) {
    store.getState().clear();
  }
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
