import "./styles/global.css";
import "./styles/app.css";
import { EmptyWorkspace, TabBar, Toolbar } from "@design/components";
import { useEffect, useMemo } from "react";
import {
  closeProjectTab,
  useSettingsStore,
  useWorkspaceStore,
  type LoomMode,
} from "@stores/index";
import SingleMode from "@modes/SingleMode";
import PlanMode from "@modes/PlanMode";
import AutoMode from "@modes/AutoMode";
import HumanReviewModal from "@modes/plan/HumanReviewModal";
import { ExecutionEventBridge } from "@modes/plan/usePlanExecution";
import { hydrateProjectGraph } from "@modes/plan/projectGraph";

const MODE_ITEMS: { id: LoomMode; label: string }[] = [
  { id: "single", label: "Single" },
  { id: "plan", label: "Plan" },
  { id: "auto", label: "Auto" },
];

function App() {
  const mode = useSettingsStore((state) => state.mode);
  const setMode = useSettingsStore((state) => state.setMode);
  const ready = useWorkspaceStore((state) => state.ready);
  const projects = useWorkspaceStore((state) => state.projects);
  const activeTabId = useWorkspaceStore((state) => state.activeTabId);
  const initialize = useWorkspaceStore((state) => state.initialize);
  const activeProject = projects.find((project) => project.id === activeTabId) ?? null;
  const toolbarItems = useMemo(
    () => MODE_ITEMS.map((item) => ({ ...item, disabled: !activeProject })),
    [activeProject],
  );

  useEffect(() => {
    void initialize();
  }, [initialize]);

  useEffect(() => {
    if (!activeProject) {
      return;
    }
    void hydrateProjectGraph(activeProject.id, activeProject.root);
  }, [activeProject]);

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
      const activeIndex = state.activeTabId ? tabs.indexOf(state.activeTabId) : -1;

      if (/^[1-9]$/.test(event.key)) {
        const projectId = tabs[Number(event.key) - 1];
        if (projectId) {
          event.preventDefault();
          state.setActiveTab(projectId);
        }
        return;
      }
      if (event.key.toLowerCase() === "t") {
        event.preventDefault();
        void state.pickAndAddProject();
        return;
      }
      if (event.key.toLowerCase() === "w" && state.activeTabId) {
        event.preventDefault();
        void closeProjectTab(state.activeTabId);
        return;
      }
      if (event.shiftKey && event.key === "]" && activeIndex >= 0) {
        event.preventDefault();
        state.setActiveTab(tabs[(activeIndex + 1) % tabs.length]);
        return;
      }
      if (event.shiftKey && event.key === "[" && activeIndex >= 0) {
        event.preventDefault();
        state.setActiveTab(tabs[(activeIndex - 1 + tabs.length) % tabs.length]);
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
        <div className="loom-app-topbar-spacer" />
        <Toolbar items={toolbarItems} value={mode} onChange={setMode} />
      </header>
      <div className="loom-app-body">
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
      </div>
      <ExecutionEventBridge />
      <HumanReviewModal />
    </div>
  );
}

export default App;
