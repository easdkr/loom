import { useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  getActiveProject,
  getExecutionStore,
  getGraphStore,
  useWorkspaceStore,
} from "@stores/index";
import { resolveWorkdir, scopeProjectId, splitProjectScopedId } from "@core/index";
import type {
  PtyCompletePayload,
  PtyDataPayload,
  PtyErrorPayload,
} from "@providers";

interface GraphNodeEvent {
  run_id: string;
  node_id: string;
}

interface GraphCompleteEvent {
  run_id: string;
  completed_nodes: string[];
}

interface GraphErrorEvent {
  run_id: string;
  node_id: string | null;
  error: string;
}

type TerminalListener = (chunk: string) => void;

const terminalListeners = new Map<string, Set<TerminalListener>>();

export function subscribeToTerminal(
  nodeId: string,
  listener: TerminalListener,
  projectId = getActiveProject()?.id,
): () => void {
  const key = projectId ? scopeProjectId(projectId, nodeId) : nodeId;
  let set = terminalListeners.get(key);
  if (!set) {
    set = new Set();
    terminalListeners.set(key, set);
  }
  set.add(listener);
  return () => {
    set?.delete(listener);
    if (set && set.size === 0) {
      terminalListeners.delete(key);
    }
  };
}

function emitTerminalChunk(nodeId: string, chunk: string) {
  const set = terminalListeners.get(nodeId);
  if (!set) {
    return;
  }
  for (const listener of set) {
    listener(chunk);
  }
}

export function ExecutionEventBridge() {
  const activeNodeIdsRef = useRef<Record<string, string[]>>({});
  useEffect(() => {
    let cancelled = false;
    let registered: UnlistenFn[] = [];

    function addActive(projectId: string, nodeId: string) {
      const store = getExecutionStore(projectId).getState();
      const current = activeNodeIdsRef.current[projectId] ?? [];
      const next = [...current];
      if (!next.includes(nodeId)) {
        next.push(nodeId);
        activeNodeIdsRef.current[projectId] = next;
        store.setActive(next);
      }
    }

    function removeActive(projectId: string, nodeId: string) {
      const store = getExecutionStore(projectId).getState();
      const next = (activeNodeIdsRef.current[projectId] ?? []).filter((id) => id !== nodeId);
      activeNodeIdsRef.current[projectId] = next;
      store.setActive(next);
    }

    Promise.all([
      listen<PtyDataPayload>("pty:data", (event) => {
        const { projectId, localId } = splitProjectScopedId(event.payload.node_id);
        if (projectId) {
          getExecutionStore(projectId).getState().appendOutput(localId, event.payload.chunk);
        }
        emitTerminalChunk(event.payload.node_id, event.payload.chunk);
      }),
      listen<PtyCompletePayload>("pty:complete", (event) => {
        const {
          node_id,
          exit_code,
          completion_reason,
          timed_out,
          truncated,
          error_class,
        } = event.payload;
        const { projectId, localId } = splitProjectScopedId(node_id);
        if (!projectId) {
          return;
        }
        const failed =
          timed_out || (exit_code !== null && exit_code !== 0) || Boolean(error_class);
        getExecutionStore(projectId).getState().setStatus(localId, {
          status: failed ? "error" : "complete",
          exitCode: exit_code,
          completionReason: completion_reason,
          completedAt: Date.now(),
          truncated: Boolean(truncated),
          errorClass: error_class ?? null,
        });
        removeActive(projectId, localId);
      }),
      listen<PtyErrorPayload>("pty:error", (event) => {
        const { projectId, localId } = splitProjectScopedId(event.payload.node_id);
        if (!projectId) {
          return;
        }
        getExecutionStore(projectId).getState().setStatus(localId, {
          status: "error",
          error: event.payload.error,
          completedAt: Date.now(),
        });
        removeActive(projectId, localId);
      }),
      listen<GraphNodeEvent>("graph:node-start", (event) => {
        const { projectId, localId } = splitProjectScopedId(event.payload.node_id);
        if (!projectId) {
          return;
        }
        getExecutionStore(projectId).getState().setStatus(localId, {
          status: "running",
          startedAt: Date.now(),
        });
        addActive(projectId, localId);
      }),
      listen<GraphNodeEvent>("graph:node-complete", () => {
        /* PTY complete event already updates status */
      }),
      listen<GraphCompleteEvent>("graph:complete", (event) => {
        const firstCompleted = event.payload.completed_nodes[0];
        const projectId = firstCompleted ? splitProjectScopedId(firstCompleted).projectId : "";
        if (!projectId) {
          return;
        }
        activeNodeIdsRef.current[projectId] = [];
        getExecutionStore(projectId).getState().setActive([]);
      }),
      listen<GraphErrorEvent>("graph:error", (event) => {
        const scopedId = event.payload.node_id;
        if (!scopedId) {
          return;
        }
        const { projectId, localId } = splitProjectScopedId(scopedId);
        if (!projectId) {
          return;
        }
        if (event.payload.node_id) {
          getExecutionStore(projectId).getState().setStatus(localId, {
            status: "error",
            error: event.payload.error,
            completedAt: Date.now(),
          });
        }
      }),
    ])
      .then((unlistens) => {
        if (cancelled) {
          unlistens.forEach((fn) => fn());
          return;
        }
        registered = unlistens;
      })
      .catch(() => {
        /* Tauri events unavailable in browser-dev mode */
      });

    return () => {
      cancelled = true;
      registered.forEach((fn) => fn());
    };
  }, []);

  return null;
}

export function usePlanExecution() {
  const activeProjectId = useWorkspaceStore((state) => state.activeTabId);

  const runPlan = useCallback(async () => {
    const project = getActiveProject();
    if (!project) {
      throw new Error("프로젝트를 먼저 선택하세요.");
    }
    const { nodes, edges } = getGraphStore(project.id).getState();
    const runnable = nodes.filter((node) => !node.skipped);
    if (runnable.length === 0) {
      throw new Error("실행할 노드가 없습니다.");
    }
    const runnableIds = new Set(runnable.map((node) => node.id));

    const plan = {
      nodes: runnable.map((node) => ({
        id: scopeProjectId(project.id, node.id),
        type: node.type,
        provider: node.provider,
        prompt: node.prompt,
        workdir: resolveWorkdir(node, project),
        env: {},
        timeout_ms: null,
      })),
      edges: edges
        .filter((edge) => runnableIds.has(edge.source) && runnableIds.has(edge.target))
        .map((edge) => ({
          from: scopeProjectId(project.id, edge.source),
          to: scopeProjectId(project.id, edge.target),
        })),
      mode: "dag" as const,
    };

    const runId = scopeProjectId(project.id, `run-${Date.now()}`);
    getExecutionStore(project.id).getState().beginRun(runId, runnable.map((node) => node.id));

    await invoke<string>("graph_execute", { request: { run_id: runId, plan } });
    return runId;
  }, [activeProjectId]);

  const cancelNode = useCallback(async (nodeId: string) => {
    const project = getActiveProject();
    await invoke("node_kill", {
      request: { node_id: project ? scopeProjectId(project.id, nodeId) : nodeId },
    });
  }, [activeProjectId]);

  return { runPlan, cancelNode };
}
