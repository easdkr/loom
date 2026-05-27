import { invoke } from "@tauri-apps/api/core";
import { scopeProjectId } from "@core/index";
import { disposeExecutionStore, getExecutionStore } from "./executionStore";
import { disposeGraphStore } from "./graphStore";
import { useWorkspaceStore } from "./workspaceStore";

async function killRunningProjectNodes(projectId: string): Promise<boolean> {
  const activeNodeIds = getExecutionStore(projectId).getState().activeNodeIds;
  if (activeNodeIds.length === 0) {
    return true;
  }
  const confirmed = window.confirm(`실행 중인 노드 ${activeNodeIds.length}개를 종료할까요?`);
  if (!confirmed) {
    return false;
  }
  await Promise.allSettled(
    activeNodeIds.map((nodeId) =>
      invoke("node_kill", { request: { node_id: scopeProjectId(projectId, nodeId) } }),
    ),
  );
  return true;
}

export async function closeProjectTab(projectId: string): Promise<void> {
  if (await killRunningProjectNodes(projectId)) {
    useWorkspaceStore.getState().closeTab(projectId);
  }
}

export async function removeProjectFromWorkspace(
  projectId: string,
  force = false,
): Promise<void> {
  if (await killRunningProjectNodes(projectId)) {
    await useWorkspaceStore.getState().removeWorkspace(projectId, force);
    disposeExecutionStore(projectId);
    disposeGraphStore(projectId);
  }
}
