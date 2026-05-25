import { useCallback, useState } from "react";
import { lastPathSegments } from "@core/index";
import { Panel, Statusbar, StatusbarSpacer, Button } from "@design/components";
import { useExecutionStore, useGraphStore, useWorkspaceStore } from "@stores/index";
import GraphCanvas from "./plan/GraphCanvas";
import NodePalette from "./plan/NodePalette";
import Inspector from "./plan/Inspector";
import ExecutionDrawer from "./plan/ExecutionDrawer";
import PlanReview from "./plan/PlanReview";
import TemplatesPanel from "./plan/TemplatesPanel";
import ProviderSwapPopover from "./plan/ProviderSwapPopover";
import { usePlanExecution } from "./plan/usePlanExecution";
import { usePlanShortcuts } from "./plan/useShortcuts";
import { loadWorkspace, saveWorkspace } from "./plan/workspace";
import "./plan/plan.css";

function PlanMode() {
  const nodeCount = useGraphStore((state) => state.nodes.length);
  const edgeCount = useGraphStore((state) => state.edges.length);
  const clear = useGraphStore((state) => state.clear);
  const activeNodeIds = useExecutionStore((state) => state.activeNodeIds);
  const runId = useExecutionStore((state) => state.runId);
  const clearExecution = useExecutionStore((state) => state.clear);
  const activeTabId = useWorkspaceStore((state) => state.activeTabId);
  const activeProject = useWorkspaceStore((state) =>
    state.projects.find((project) => project.id === activeTabId),
  );
  const { runPlan, cancelNode, writeNodeInput, writeNodeControl } = usePlanExecution();
  const [message, setMessage] = useState("Ready");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [swapNodeId, setSwapNodeId] = useState<string | null>(null);

  const handleRun = useCallback(async () => {
    try {
      setMessage("Submitting plan...");
      const id = await runPlan();
      setMessage(`Run ${id} started`);
    } catch (error) {
      setMessage(String(error));
    }
  }, [runPlan]);

  const handleSave = useCallback(async () => {
    try {
      const path = await saveWorkspace();
      setMessage(`Saved → ${path}`);
    } catch (error) {
      setMessage(String(error));
    }
  }, []);

  const handleLoad = useCallback(async () => {
    try {
      const { path, loaded } = await loadWorkspace();
      setMessage(loaded ? `Loaded ← ${path}` : `No saved workspace at ${path}`);
    } catch (error) {
      setMessage(String(error));
    }
  }, []);

  const handleReplaceProvider = useCallback((nodeId: string) => {
    setSwapNodeId(nodeId);
  }, []);

  const handleOpenTemplates = useCallback(() => {
    setTemplatesOpen(true);
  }, []);

  usePlanShortcuts({
    onRun: handleRun,
    onSave: handleSave,
    onLoad: handleLoad,
    onReplaceProvider: handleReplaceProvider,
    onOpenTemplates: handleOpenTemplates,
  });

  const running = activeNodeIds.length > 0;

  return (
    <section className="mode-layout mode-layout--plan">
      <Panel
        className="mode-sidebar"
        title="Palette"
        actions={
          <Button size="sm" variant="ghost" onClick={clear} disabled={nodeCount === 0}>
            Clear
          </Button>
        }
        flush
      >
        <NodePalette />
      </Panel>

      <Panel
        className="mode-canvas"
        title="Graph"
        actions={
          <div className="plan-canvas-actions">
            <Button size="sm" variant="ghost" onClick={() => setTemplatesOpen(true)}>
              Templates
            </Button>
            <Button size="sm" variant="ghost" onClick={handleLoad}>
              Load
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={handleSave}
              disabled={nodeCount === 0}
            >
              Save
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={clearExecution}
              disabled={!runId || running}
            >
              Reset
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setReviewOpen(true)}
              disabled={nodeCount === 0}
            >
              Review
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={handleRun}
              disabled={running || nodeCount === 0}
            >
              Run
            </Button>
          </div>
        }
        flush
        bodyFlush
      >
        <div className="plan-canvas-stack">
          <div className="plan-canvas-graph">
            <GraphCanvas />
          </div>
          <ExecutionDrawer
            onCancelNode={cancelNode}
            onWriteNode={writeNodeInput}
            onWriteNodeControl={writeNodeControl}
          />
        </div>
      </Panel>

      <Panel className="mode-inspector" title="Inspector" flush>
        <Inspector />
      </Panel>

      <Statusbar className="mode-statusbar" data-status={running ? "running" : "idle"}>
        <span className="loom-status-dot" />
        <span>{message}</span>
        <StatusbarSpacer />
        <span>{activeProject ? lastPathSegments(activeProject.root) : "no project"}</span>
        <span>
          nodes: {nodeCount} · edges: {edgeCount} · active: {activeNodeIds.length}
        </span>
      </Statusbar>

      <PlanReview
        open={reviewOpen}
        onClose={() => setReviewOpen(false)}
        onApprove={() => {
          setReviewOpen(false);
          void handleRun();
        }}
      />

      <TemplatesPanel
        open={templatesOpen}
        saveDisabled={nodeCount === 0}
        onClose={() => setTemplatesOpen(false)}
        onApplied={(name) => setMessage(`Template loaded: ${name}`)}
      />

      <ProviderSwapPopover
        open={swapNodeId !== null}
        nodeId={swapNodeId}
        onClose={() => setSwapNodeId(null)}
      />
    </section>
  );
}

export default PlanMode;
