import type { ExecutionStatus, NodeExecution } from "./executionStore";

export type WorkspaceDerivedStatus = "review" | "running" | "error" | "complete" | "idle";

interface WorkspaceStatusInput {
  pendingReview?: boolean;
  activeNodeIds?: string[];
  perNode?: Record<string, Pick<NodeExecution, "status">>;
}

export function deriveWorkspaceStatus({
  pendingReview = false,
  activeNodeIds = [],
  perNode = {},
}: WorkspaceStatusInput): WorkspaceDerivedStatus {
  if (pendingReview) {
    return "review";
  }
  const executions = Object.values(perNode);
  if (
    activeNodeIds.length > 0 ||
    executions.some((item) => item.status === "running" || item.status === "queued")
  ) {
    return "running";
  }
  if (executions.some((item) => item.status === "error")) {
    return "error";
  }
  if (executions.some((item) => item.status === "complete")) {
    return "complete";
  }
  return "idle";
}

export function executionStatusFromWorkspaceStatus(
  status: WorkspaceDerivedStatus,
): ExecutionStatus {
  return status === "review" ? "running" : status;
}
