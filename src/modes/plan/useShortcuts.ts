import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useExecutionStore, useGraphStore } from "@stores/index";

interface ShortcutHandlers {
  onRun: () => Promise<void> | void;
  onSave: () => Promise<void> | void;
  onLoad: () => Promise<void> | void;
}

function isTextEditingElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    return true;
  }
  return target.isContentEditable;
}

export function usePlanShortcuts(handlers: ShortcutHandlers) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey;

      if (mod && event.key === "Enter") {
        event.preventDefault();
        void handlers.onRun();
        return;
      }

      if (mod && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void handlers.onSave();
        return;
      }

      if (mod && event.key.toLowerCase() === "o") {
        event.preventDefault();
        void handlers.onLoad();
        return;
      }

      if (mod && event.key === ".") {
        event.preventDefault();
        const active = useExecutionStore.getState().activeNodeIds;
        for (const nodeId of active) {
          void invoke("node_kill", { request: { node_id: nodeId } }).catch(() => undefined);
        }
        return;
      }

      if (isTextEditingElement(event.target)) {
        return;
      }

      const state = useGraphStore.getState();
      const selected = state.selectedNodeId
        ? state.nodes.find((node) => node.id === state.selectedNodeId)
        : null;

      if ((event.key === "Backspace" || event.key === "Delete") && selected) {
        event.preventDefault();
        state.removeNode(selected.id);
        return;
      }

      if (event.key.toLowerCase() === "s" && selected) {
        event.preventDefault();
        state.updateNode(selected.id, { skipped: !selected.skipped });
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [handlers]);
}
