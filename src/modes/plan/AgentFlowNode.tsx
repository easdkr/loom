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
        badge={<Badge tone="neutral">{node.provider}</Badge>}
        footer={<span>{node.type}</span>}
      >
        <p className="ds-agent-node-prompt">{node.prompt || "(prompt 없음)"}</p>
      </AgentNodeShell>
      <Handle type="source" position={Position.Right} />
    </>
  );
}

export default AgentFlowNode;
