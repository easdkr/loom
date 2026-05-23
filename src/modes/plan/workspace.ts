import { invoke } from "@tauri-apps/api/core";
import { useGraphStore, type GraphEdge, type GraphNode } from "@stores/index";

const WORKSPACE_VERSION = 1 as const;

interface WorkspacePayload {
  version: typeof WORKSPACE_VERSION;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

interface WorkspaceLoadResponse {
  path: string;
  payload: string | null;
}

export async function saveWorkspace(): Promise<string> {
  const { nodes, edges } = useGraphStore.getState();
  const payload: WorkspacePayload = { version: WORKSPACE_VERSION, nodes, edges };
  return invoke<string>("workspace_save", { request: { payload: JSON.stringify(payload) } });
}

export async function loadWorkspace(): Promise<{ path: string; loaded: boolean }> {
  const response = await invoke<WorkspaceLoadResponse>("workspace_load");
  if (!response.payload) {
    return { path: response.path, loaded: false };
  }
  const parsed = JSON.parse(response.payload) as WorkspacePayload;
  if (parsed.version !== WORKSPACE_VERSION) {
    throw new Error(`unsupported workspace version: ${parsed.version}`);
  }
  const store = useGraphStore.getState();
  store.setNodes(parsed.nodes);
  store.setEdges(parsed.edges);
  store.selectNode(null);
  return { path: response.path, loaded: true };
}
