import type { ReactNode } from "react";
import type { NodeMeta } from "@core/index";

export type AgentNodeStatus =
  | "idle"
  | "queued"
  | "running"
  | "complete"
  | "error"
  | "skipped";

interface AgentNodeShellProps {
  meta: NodeMeta;
  status?: AgentNodeStatus;
  selected?: boolean;
  badge?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
}

const CATEGORY_TOKEN: Record<NodeMeta["category"], string> = {
  orchestrator: "var(--node-orchestrator)",
  worker: "var(--node-worker)",
  collector: "var(--node-collector)",
  reviewer: "var(--node-reviewer)",
  router: "var(--node-router)",
  trigger: "var(--node-router)",
};

export function AgentNodeShell({
  meta,
  status = "idle",
  selected = false,
  badge,
  footer,
  children,
}: AgentNodeShellProps) {
  const stripe = CATEGORY_TOKEN[meta.category] ?? "var(--node-router)";

  return (
    <div
      className="ds-agent-node"
      data-status={status}
      data-selected={selected ? "true" : "false"}
      style={{ ["--node-stripe-color" as string]: stripe }}
    >
      <span className="ds-agent-node-stripe" aria-hidden />
      <header className="ds-agent-node-header">
        <span className="ds-agent-node-title">{meta.name}</span>
        {badge}
        <span className="ds-agent-node-status" data-status={status} aria-hidden />
      </header>
      <div className="ds-agent-node-body">{children}</div>
      <footer className="ds-agent-node-footer">{footer}</footer>
    </div>
  );
}
