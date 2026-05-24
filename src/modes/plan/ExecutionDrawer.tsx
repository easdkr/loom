import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, type BadgeTone } from "@design/components";
import TerminalOutput, { type TerminalOutputHandle } from "@modes/TerminalOutput";
import { useExecutionStore, useGraphStore, type ExecutionStatus } from "@stores/index";
import { subscribeToTerminal } from "./usePlanExecution";

const STATUS_TONE: Record<ExecutionStatus, BadgeTone> = {
  idle: "neutral",
  queued: "info",
  running: "accent",
  complete: "success",
  error: "danger",
  skipped: "neutral",
};

interface NodeTerminalProps {
  nodeId: string;
}

function NodeTerminal({ nodeId }: NodeTerminalProps) {
  const terminalRef = useRef<TerminalOutputHandle | null>(null);
  const bufferedOutput = useExecutionStore((state) => state.outputByNode[nodeId] ?? "");

  useEffect(() => {
    terminalRef.current?.reset();
    if (bufferedOutput) {
      terminalRef.current?.write(bufferedOutput);
    }
    const unsubscribe = subscribeToTerminal(nodeId, (chunk) => {
      terminalRef.current?.write(chunk);
    });
    return () => {
      unsubscribe();
    };
  }, [nodeId]);

  return (
    <TerminalOutput
      ref={terminalRef}
      active={false}
      onInput={() => undefined}
      onResize={() => undefined}
    />
  );
}

interface ExecutionDrawerProps {
  onCancelNode: (nodeId: string) => Promise<void>;
}

function ExecutionDrawer({ onCancelNode }: ExecutionDrawerProps) {
  const perNode = useExecutionStore((state) => state.perNode);
  const nodes = useGraphStore((state) => state.nodes);
  const [activeTab, setActiveTab] = useState<string | null>(null);

  const tabs = useMemo(
    () =>
      Object.entries(perNode)
        .map(([id, exec]) => {
          const node = nodes.find((n) => n.id === id);
          return { id, exec, label: node?.meta.name ?? id };
        })
        .sort((a, b) => (a.exec.startedAt ?? 0) - (b.exec.startedAt ?? 0)),
    [perNode, nodes],
  );

  useEffect(() => {
    if (tabs.length === 0) {
      setActiveTab(null);
      return;
    }
    if (!activeTab || !tabs.some((tab) => tab.id === activeTab)) {
      const running = tabs.find((tab) => tab.exec.status === "running");
      setActiveTab(running?.id ?? tabs[0].id);
    }
  }, [tabs, activeTab]);

  if (tabs.length === 0) {
    return null;
  }

  return (
    <aside className="plan-drawer">
      <div className="plan-drawer-tabs" role="tablist">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={tab.id === activeTab}
            data-active={tab.id === activeTab}
            className="plan-drawer-tab"
            onClick={() => setActiveTab(tab.id)}
          >
            <Badge tone={STATUS_TONE[tab.exec.status]}>{tab.exec.status}</Badge>
            <span className="plan-drawer-tab-label">{tab.label}</span>
          </button>
        ))}
      </div>
      <div className="plan-drawer-body">
        {activeTab ? (
          <>
            <div className="plan-drawer-toolbar">
              <span className="plan-drawer-meta">node: {activeTab}</span>
              <Button
                size="sm"
                variant="danger"
                onClick={() => onCancelNode(activeTab)}
                disabled={perNode[activeTab]?.status !== "running"}
              >
                Kill
              </Button>
            </div>
            <NodeTerminal nodeId={activeTab} />
          </>
        ) : null}
      </div>
    </aside>
  );
}

export default ExecutionDrawer;
