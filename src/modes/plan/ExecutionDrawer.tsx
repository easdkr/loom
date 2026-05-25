import { useEffect, useMemo, useState } from "react";
import { Badge, type BadgeTone } from "@design/components";
import AgentRunView from "@modes/AgentRunView";
import { useExecutionStore, useGraphStore, type ExecutionStatus } from "@stores/index";

const STATUS_TONE: Record<ExecutionStatus, BadgeTone> = {
  idle: "neutral",
  queued: "info",
  running: "accent",
  complete: "success",
  error: "danger",
  skipped: "neutral",
};

interface ExecutionDrawerProps {
  onCancelNode: (nodeId: string) => Promise<void>;
  onWriteNode: (nodeId: string, input: string) => Promise<void>;
  onWriteNodeControl: (nodeId: string, input: string) => Promise<void>;
}

function ExecutionDrawer({ onCancelNode, onWriteNode, onWriteNodeControl }: ExecutionDrawerProps) {
  const perNode = useExecutionStore((state) => state.perNode);
  const outputByNode = useExecutionStore((state) => state.outputByNode);
  const transcriptByNode = useExecutionStore((state) => state.transcriptByNode);
  const activityByNode = useExecutionStore((state) => state.activityByNode);
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

  const active = activeTab ? tabs.find((tab) => tab.id === activeTab) : null;
  const activeNode = active ? nodes.find((node) => node.id === active.id) : null;
  const activeStatus = active?.exec.status ?? "idle";

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
        {active && activeNode ? (
          <AgentRunView
            nodeId={active.id}
            provider={activeNode.provider}
            status={activeStatus}
            title={activeNode.meta.name}
            subtitle={active.id}
            messages={transcriptByNode[active.id] ?? []}
            rawOutput={outputByNode[active.id] ?? ""}
            activity={activityByNode[active.id]}
            running={activeStatus === "running"}
            meta={<span className="plan-drawer-meta">{activeNode.type}</span>}
            onCancel={() => onCancelNode(active.id)}
            onSubmitInput={(input) => onWriteNode(active.id, input)}
            onSubmitControl={(input) => onWriteNodeControl(active.id, input)}
            cancelDisabled={activeStatus !== "running"}
          />
        ) : null}
      </div>
    </aside>
  );
}

export default ExecutionDrawer;
