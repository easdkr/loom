import { invoke } from "@tauri-apps/api/core";
import type { ProjectGraphPayloadV1 } from "@core/index";
import {
  getActiveProject,
  getGraphStore,
  useGraphStore,
  type GraphEdge,
  type GraphNode,
} from "@stores/index";

const PROJECT_GRAPH_VERSION = 1 as const;
const loadedProjectIds = new Set<string>();

interface ProjectGraphLoadResponse {
  path: string;
  payload: string | null;
}

type GraphPayload = ProjectGraphPayloadV1<GraphNode, GraphEdge>;

function serializeGraph(nodes: GraphNode[], edges: GraphEdge[]): string {
  const payload: GraphPayload = {
    version: PROJECT_GRAPH_VERSION,
    nodes,
    edges,
  };
  return JSON.stringify(payload);
}

function applyGraph(projectId: string, payload: GraphPayload): void {
  if (payload.version !== PROJECT_GRAPH_VERSION) {
    throw new Error(`unsupported project graph version: ${String(payload.version)}`);
  }
  const store = getGraphStore(projectId).getState();
  store.setNodes(payload.nodes);
  store.setEdges(payload.edges);
  store.selectNode(null);
}

export async function saveWorkspace(): Promise<string> {
  const project = getActiveProject();
  if (!project) {
    throw new Error("active project is required to save graph");
  }
  const { nodes, edges } = useGraphStore.getState();
  return invoke<string>("project_graph_save", {
    request: { root: project.root, payload: serializeGraph(nodes, edges) },
  });
}

export async function loadWorkspace(): Promise<{ path: string; loaded: boolean }> {
  const project = getActiveProject();
  if (!project) {
    throw new Error("active project is required to load graph");
  }
  const response = await invoke<ProjectGraphLoadResponse>("project_graph_load", {
    request: { root: project.root },
  });
  if (!response.payload) {
    loadedProjectIds.add(project.id);
    return { path: response.path, loaded: false };
  }
  applyGraph(project.id, JSON.parse(response.payload) as GraphPayload);
  loadedProjectIds.add(project.id);
  return { path: response.path, loaded: true };
}

export async function hydrateProjectGraph(projectId: string, root: string): Promise<void> {
  if (loadedProjectIds.has(projectId)) {
    return;
  }
  const response = await invoke<ProjectGraphLoadResponse>("project_graph_load", {
    request: { root },
  }).catch(() => null);
  if (!response) {
    return;
  }
  if (response.payload) {
    applyGraph(projectId, JSON.parse(response.payload) as GraphPayload);
  }
  loadedProjectIds.add(projectId);
}
