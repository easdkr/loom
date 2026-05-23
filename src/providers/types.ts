export type ProviderInputMode = "append-arg" | "stdin";

export interface ProviderConfig {
  name: string;
  type: "pty" | (string & {});
  command: string;
  args: string[];
  env: Record<string, string>;
  completion_pattern: string;
  input_mode: ProviderInputMode;
  cols: number;
  rows: number;
  completion_timeout_ms: number;
  idle_timeout_ms: number;
}

export interface ProvidersResponse {
  providers: ProviderConfig[];
  config_path: string;
}

export interface PtyTaskRequest {
  node_id?: string | null;
  provider: string;
  prompt: string;
  workdir?: string | null;
  env?: Record<string, string>;
  timeout_ms?: number | null;
  cols?: number | null;
  rows?: number | null;
}

export interface PtyDataPayload {
  node_id: string;
  chunk: string;
}

export interface PtyCompletePayload {
  node_id: string;
  result: string;
  completion_reason: string;
  exit_code: number | null;
  timed_out: boolean;
}

export interface PtyErrorPayload {
  node_id: string;
  error: string;
}
