import "./styles/global.css";
import "./styles/app.css";
import { EmptyWorkspace, IconButton, TabBar, Toolbar, WorkspaceSidebar } from "@design/components";
import { useCallback, useEffect, useState } from "react";
import type { LoomMode } from "@core/index";
import {
  closeProjectTab,
  useWorkspaceStore,
} from "@stores/index";
import SingleMode from "@modes/SingleMode";
import PlanMode from "@modes/PlanMode";
import AutoMode from "@modes/AutoMode";
import { CommandPalette } from "@modes/CommandPalette";
import HumanReviewModal from "@modes/plan/HumanReviewModal";
import { ExecutionEventBridge } from "@modes/plan/usePlanExecution";
import { hydrateProjectGraph } from "@modes/plan/projectGraph";

function App() {
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const ready = useWorkspaceStore((state) => state.ready);
  const projects = useWorkspaceStore((state) => state.projects);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const initialize = useWorkspaceStore((state) => state.initialize);
  const setWorkspaceMode = useWorkspaceStore((state) => state.setWorkspaceMode);
  const activeProject = projects.find((project) => project.id === activeWorkspaceId) ?? null;
  const mode = activeProject?.mode ?? "plan";
  const setMode = useCallback(
    (nextMode: LoomMode) => {
      if (activeProject) {
        setWorkspaceMode(activeProject.id, nextMode);
      }
    },
    [activeProject, setWorkspaceMode],
  );

  useEffect(() => {
    void initialize();
  }, [initialize]);

  useEffect(() => {
    if (!activeProject) {
      return;
    }
    void hydrateProjectGraph(activeProject.id, activeProject.root);
  }, [activeProject?.id]);

  useEffect(() => {
    function isTextInput(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) {
        return false;
      }
      return (
        target.isContentEditable ||
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT"
      );
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (!event.metaKey || event.altKey || event.ctrlKey || isTextInput(event.target)) {
        return;
      }
      const state = useWorkspaceStore.getState();
      const tabs = state.openTabs;
      const activeIndex = state.activeWorkspaceId ? tabs.indexOf(state.activeWorkspaceId) : -1;

      if (/^[1-9]$/.test(event.key)) {
        const projectId = tabs[Number(event.key) - 1];
        if (projectId) {
          event.preventDefault();
          state.setActiveWorkspace(projectId);
        }
        return;
      }
      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandPaletteOpen(true);
        return;
      }
      if (event.key.toLowerCase() === "t") {
        event.preventDefault();
        void state.pickAndAddProject();
        return;
      }
      if (event.key.toLowerCase() === "w" && state.activeWorkspaceId) {
        event.preventDefault();
        void closeProjectTab(state.activeWorkspaceId);
        return;
      }
      if (event.shiftKey && event.key === "]" && activeIndex >= 0) {
        event.preventDefault();
        state.setActiveWorkspace(tabs[(activeIndex + 1) % tabs.length]);
        return;
      }
      if (event.shiftKey && event.key === "[" && activeIndex >= 0) {
        event.preventDefault();
        state.setActiveWorkspace(tabs[(activeIndex - 1 + tabs.length) % tabs.length]);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div className="loom-app">
      <header className="loom-app-topbar">
        <div className="loom-brand">
          <img className="loom-brand-logo" src="/logo.png" alt="Loom" />
        </div>
        <TabBar />
        <IconButton
          aria-label="Open command palette"
          title="Command palette"
          onClick={() => setCommandPaletteOpen(true)}
        >
          ⌘K
        </IconButton>
        <Toolbar<LoomMode>
          value={mode}
          onChange={setMode}
          items={[
            { id: "single", label: "Single", disabled: !activeProject },
            { id: "plan", label: "Plan", disabled: !activeProject },
            { id: "auto", label: "Auto", disabled: !activeProject },
          ]}
        />
      </header>
      <div className="loom-app-body">
        <WorkspaceSidebar />
        <main className="loom-app-workspace">
          {!ready ? (
            <div className="mode-placeholder">Loading workspace...</div>
          ) : !activeProject ? (
            <EmptyWorkspace />
          ) : (
            <>
              {mode === "single" && <SingleMode />}
              {mode === "plan" && <PlanMode />}
              {mode === "auto" && <AutoMode />}
            </>
          )}
        </main>
      </div>
      <ExecutionEventBridge />
      <HumanReviewModal />
      <CommandPalette open={commandPaletteOpen} onClose={() => setCommandPaletteOpen(false)} />
    </div>
  );
}

export default App;
