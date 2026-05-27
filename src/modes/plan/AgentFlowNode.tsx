import { Handle, Position, type NodeProps } from "@xyflow/react";
import { AgentNodeShell, Badge, type AgentNodeStatus } from "@design/components";
import type { NodeMeta } from "@core/index";

export interface AgentFlowNodeData extends Record<string, unknown> {
  type: string;
  meta: NodeMeta;
  provider: string;
  prompt: string;
  status: AgentNodeStatus;
  skipped?: boolean;
  repoName?: string;
  repoBranch?: string;
  worktreePolicy?: "workspace" | "node-isolated";
}

function AgentFlowNode({ data, selected }: NodeProps) {
  const node = data as AgentFlowNodeData;
  const status: AgentNodeStatus = node.skipped ? "skipped" : node.status ?? "idle";

  return (
    <>
      <Handle type="target" position={Position.Left} />
      <AgentNodeShell
        meta={node.meta}
        status={status}
        selected={selected}
        badge={
          <span className="ds-agent-node-badges">
            <Badge tone="neutral" title={node.provider}>{node.provider}</Badge>
            {node.repoName ? (
              <Badge tone="info" title={node.repoBranch ? `${node.repoName} · ${node.repoBranch}` : node.repoName}>
                {node.repoName}
              </Badge>
            ) : null}
            {node.worktreePolicy === "node-isolated" ? <Badge tone="accent">isolated</Badge> : null}
          </span>
        }
        footer={
          <>
            <span>{node.type}</span>
            {node.repoBranch ? <span className="ds-agent-node-footer-meta">{node.repoBranch}</span> : null}
          </>
        }
      >
        <p className="ds-agent-node-prompt">{node.prompt || "(prompt 없음)"}</p>
      </AgentNodeShell>
      <Handle type="source" position={Position.Right} />
    </>
  );
}

export default AgentFlowNode;
