import { useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useExecutionStore, useGraphStore } from "@stores/index";
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

export function subscribeToTerminal(nodeId: string, listener: TerminalListener): () => void {
  let set = terminalListeners.get(nodeId);
  if (!set) {
    set = new Set();
    terminalListeners.set(nodeId, set);
  }
  set.add(listener);
  return () => {
    set?.delete(listener);
    if (set && set.size === 0) {
      terminalListeners.delete(nodeId);
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

export function usePlanExecution() {
  const beginRun = useExecutionStore((state) => state.beginRun);
  const setStatus = useExecutionStore((state) => state.setStatus);
  const setActive = useExecutionStore((state) => state.setActive);
  const activeNodeIdsRef = useRef<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    let registered: UnlistenFn[] = [];

    function addActive(nodeId: string) {
      const next = [...activeNodeIdsRef.current];
      if (!next.includes(nodeId)) {
        next.push(nodeId);
        activeNodeIdsRef.current = next;
        setActive(next);
      }
    }

    function removeActive(nodeId: string) {
      const next = activeNodeIdsRef.current.filter((id) => id !== nodeId);
      activeNodeIdsRef.current = next;
      setActive(next);
    }

    Promise.all([
      listen<PtyDataPayload>("pty:data", (event) => {
        emitTerminalChunk(event.payload.node_id, event.payload.chunk);
      }),
      listen<PtyCompletePayload>("pty:complete", (event) => {
        const { node_id, exit_code, completion_reason, timed_out } = event.payload;
        setStatus(node_id, {
          status: timed_out ? "error" : "complete",
          exitCode: exit_code,
          completionReason: completion_reason,
          completedAt: Date.now(),
        });
        removeActive(node_id);
      }),
      listen<PtyErrorPayload>("pty:error", (event) => {
        setStatus(event.payload.node_id, {
          status: "error",
          error: event.payload.error,
          completedAt: Date.now(),
        });
        removeActive(event.payload.node_id);
      }),
      listen<GraphNodeEvent>("graph:node-start", (event) => {
        setStatus(event.payload.node_id, {
          status: "running",
          startedAt: Date.now(),
        });
        addActive(event.payload.node_id);
      }),
      listen<GraphNodeEvent>("graph:node-complete", () => {
        /* PTY complete event already updates status */
      }),
      listen<GraphCompleteEvent>("graph:complete", () => {
        activeNodeIdsRef.current = [];
        setActive([]);
      }),
      listen<GraphErrorEvent>("graph:error", (event) => {
        if (event.payload.node_id) {
          setStatus(event.payload.node_id, {
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
  }, [setStatus, setActive]);

  const runPlan = useCallback(async () => {
    const { nodes, edges } = useGraphStore.getState();
    const runnable = nodes.filter((node) => !node.skipped);
    if (runnable.length === 0) {
      throw new Error("실행할 노드가 없습니다.");
    }
    const runnableIds = new Set(runnable.map((node) => node.id));

    const plan = {
      nodes: runnable.map((node) => ({
        id: node.id,
        type: node.type,
        provider: node.provider,
        prompt: node.prompt,
        workdir: node.workdir ?? null,
        env: {},
        timeout_ms: null,
      })),
      edges: edges
        .filter((edge) => runnableIds.has(edge.source) && runnableIds.has(edge.target))
        .map((edge) => ({ from: edge.source, to: edge.target })),
      mode: "dag" as const,
    };

    const runId = `run-${Date.now()}`;
    beginRun(runId, runnable.map((node) => node.id));
    activeNodeIdsRef.current = [];

    await invoke<string>("graph_execute", { request: { run_id: runId, plan } });
    return runId;
  }, [beginRun]);

  const cancelNode = useCallback(async (nodeId: string) => {
    await invoke("node_kill", { request: { node_id: nodeId } });
  }, []);

  return { runPlan, cancelNode };
}
