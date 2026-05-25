export type ProviderInputMode = "append-arg" | "stdin";
export type ProviderDisplayMode = "agent" | "terminal";

export interface ProviderConfig {
  name: string;
  type: "pty" | (string & {});
  command: string;
  args: string[];
  env: Record<string, string>;
  completion_pattern: string;
  input_mode: ProviderInputMode;
  display_mode?: ProviderDisplayMode;
  cols: number;
  rows: number;
  completion_timeout_ms: number;
  idle_timeout_ms: number;
  /** Provider-specific error pattern (rate limit, quota, fatal). Optional. */
  error_pattern?: string;
  /**
   * Time the completion pattern must remain stable (no new output) before
   * the session is finalized. Defends against false positives where the
   * model momentarily emits a completion-looking phrase. Defaults to 800ms.
   */
  settle_ms?: number;
  /**
   * Maximum bytes retained from the PTY raw output. Older bytes are
   * discarded (FIFO) once exceeded; the final result reports `truncated`.
   * Defaults to 1 MiB.
   */
  max_output_bytes?: number;
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

export interface PtyAgentPayload {
  node_id: string;
  assistant_content: string;
  activity?: string | null;
  lines: string[];
}

export interface PtyCompletePayload {
  node_id: string;
  result: string;
  completion_reason: string;
  exit_code: number | null;
  timed_out: boolean;
  truncated?: boolean;
  error_class?: "rate-limit" | "provider-error" | null;
}

export interface PtyErrorPayload {
  node_id: string;
  error: string;
}
