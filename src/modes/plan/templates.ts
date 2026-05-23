import { invoke } from "@tauri-apps/api/core";
import {
  useGraphStore,
  type GraphEdge,
  type GraphNode,
} from "@stores/index";

export interface TemplateMetadata {
  name: string;
  display_name: string;
  description: string;
  builtin: boolean;
  node_count: number;
  path: string | null;
}

export interface TemplatesResponse {
  templates: TemplateMetadata[];
  directory: string;
}

interface TemplatePayloadJson {
  version: 1;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

interface TemplateLoadResponse {
  name: string;
  payload: string;
}

export async function listTemplates(): Promise<TemplatesResponse> {
  return invoke<TemplatesResponse>("list_templates_command");
}

export async function applyTemplate(name: string): Promise<void> {
  const response = await invoke<TemplateLoadResponse>("load_template_command", {
    request: { name },
  });
  const parsed = JSON.parse(response.payload) as TemplatePayloadJson;
  if (parsed.version !== 1) {
    throw new Error(`unsupported template version: ${parsed.version}`);
  }
  const store = useGraphStore.getState();
  store.setNodes(parsed.nodes);
  store.setEdges(parsed.edges);
  store.selectNode(null);
}

export async function saveCurrentAsTemplate(
  name: string,
  displayName: string,
  description: string,
): Promise<string> {
  const { nodes, edges } = useGraphStore.getState();
  const response = await invoke<{ path: string }>("save_template_command", {
    request: {
      name,
      display_name: displayName,
      description,
      payload: { version: 1, nodes, edges },
    },
  });
  return response.path;
}

export async function deleteTemplate(name: string): Promise<void> {
  await invoke("delete_template_command", { request: { name } });
}
