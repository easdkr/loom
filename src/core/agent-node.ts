export type BuiltinNodeType =
  | "orchestrator:sequential"
  | "orchestrator:parallel"
  | "orchestrator:supervisor"
  | "orchestrator:pipeline"
  | "worker:pty"
  | "worker:http"
  | "worker:shell"
  | "collector:result"
  | "reviewer:llm"
  | "reviewer:human"
  | "router:condition"
  | "trigger:webhook";

export type NodeType = BuiltinNodeType | (string & {});

export interface NodeMeta {
  name: string;
  icon?: string;
  category:
    | "orchestrator"
    | "worker"
    | "collector"
    | "reviewer"
    | "router"
    | "trigger";
  colorToken: string;
}

export interface Artifact {
  id: string;
  kind: "file" | "diff" | "stdout" | "stderr" | (string & {});
  label: string;
  content: string;
}

export interface ExecutionRecord {
  nodeId: string;
  status: TaskResultStatus;
  startedAt: string;
  completedAt?: string;
  summary?: string;
}

export interface TaskContext {
  id: string;
  origin: Task;
  artifacts: Artifact[];
  history: ExecutionRecord[];
  metadata: {
    startedAt: string;
    workdir: string;
    env?: Record<string, string>;
  };
}

export interface Task {
  id: string;
  prompt: string;
  context?: TaskContext;
  metadata?: Record<string, string>;
}

export type TaskResultStatus = "success" | "error" | "skipped";

export interface TaskResult {
  status: TaskResultStatus;
  output: string;
  artifacts: Artifact[];
  error?: string;
}

export interface AgentNode {
  id: string;
  type: NodeType;
  meta: NodeMeta;
  receive(task: Task): Promise<TaskResult>;
  children?: AgentNode[];
  onInit?(): Promise<void>;
  onDestroy?(): Promise<void>;
}
