export interface Project {
  id: string;
  root: string;
  name: string;
  providersOverride?: string;
  lastOpenedAt: number;
}

export interface WorkspaceRegistryV2 {
  version: 2;
  projects: Project[];
  openTabs: string[];
  activeTabId: string | null;
}

export interface ProjectGraphPayloadV1<TNode = unknown, TEdge = unknown> {
  version: 1;
  nodes: TNode[];
  edges: TEdge[];
}
