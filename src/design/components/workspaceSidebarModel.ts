import type { Project } from "@core/index";
import type { WorkspaceDerivedStatus } from "@stores/workspaceStatus";

export const WORKSPACE_STATUS_ORDER: WorkspaceDerivedStatus[] = [
  "review",
  "running",
  "error",
  "idle",
  "complete",
];

export const WORKSPACE_STATUS_LABEL: Record<WorkspaceDerivedStatus, string> = {
  review: "Review",
  running: "Running",
  error: "Failed",
  idle: "Idle",
  complete: "Done",
};

export interface WorkspaceStatusEntry {
  project: Project;
  status: WorkspaceDerivedStatus;
}

export function groupWorkspaceEntries(entries: WorkspaceStatusEntry[]): WorkspaceStatusEntry[][] {
  return WORKSPACE_STATUS_ORDER.map((status) =>
    entries
      .filter((entry) => entry.status === status)
      .sort((a, b) => b.project.lastOpenedAt - a.project.lastOpenedAt),
  );
}
