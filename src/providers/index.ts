import type { ProviderConfig, ProviderDisplayMode } from "./types";

const RATE_LIMIT_PATTERN =
  "(?i)(rate.?limit|429 too many|usage limit|quota exceeded|context length exceeded)";
const AGENT_COMPLETION_PATTERN =
  "(?m)(Task complete|Done|Finished|>\\s*$|^[\\s*✢✳✽✻✣✶✱✦✧✩✪✫⚡+·•◦°]*[A-Za-z][A-Za-z -]{1,40}(?:ed|ing)\\s+for\\s+(?:\\d+m\\s*)?\\d+s\\s*$)";

export function defaultDisplayModeForProvider(
  provider: Pick<ProviderConfig, "name" | "command">,
): ProviderDisplayMode {
  const identity = `${provider.name} ${provider.command}`.toLowerCase();
  if (
    identity.includes("claude") ||
    identity.includes("croxy") ||
    identity.includes("codex") ||
    identity.includes("cursor")
  ) {
    return "agent";
  }
  return "terminal";
}

export const fallbackProviders: ProviderConfig[] = [
  {
    name: "shell",
    type: "pty",
    command: "/bin/zsh",
    args: ["-lc"],
    env: { FORCE_COLOR: "0", NO_COLOR: "1", TERM: "xterm-256color" },
    completion_pattern: "(?m)^LOOM_EXIT:\\d+\\r?$",
    input_mode: "append-arg",
    display_mode: "terminal",
    cols: 220,
    rows: 50,
    completion_timeout_ms: 120000,
    idle_timeout_ms: 30000,
    error_pattern: "",
    settle_ms: 200,
    max_output_bytes: 1048576,
  },
  {
    name: "croxy",
    type: "croxy",
    command: "croxy",
    args: ["--permission-mode", "bypassPermissions"],
    env: { FORCE_COLOR: "0", NO_COLOR: "1", TERM: "xterm-256color" },
    completion_pattern: AGENT_COMPLETION_PATTERN,
    input_mode: "append-arg",
    display_mode: "agent",
    cols: 220,
    rows: 50,
    completion_timeout_ms: 1800000,
    idle_timeout_ms: 300000,
    error_pattern: RATE_LIMIT_PATTERN,
    settle_ms: 1200,
    max_output_bytes: 2097152,
  },
  {
    name: "codex",
    type: "pty",
    command: "codex",
    args: [],
    env: { FORCE_COLOR: "0", NO_COLOR: "1", TERM: "xterm-256color" },
    completion_pattern: AGENT_COMPLETION_PATTERN,
    input_mode: "append-arg",
    display_mode: "agent",
    cols: 220,
    rows: 50,
    completion_timeout_ms: 1800000,
    idle_timeout_ms: 300000,
    error_pattern: RATE_LIMIT_PATTERN,
    settle_ms: 1200,
    max_output_bytes: 2097152,
  },
  {
    name: "cursor",
    type: "pty",
    command: "cursor-agent",
    args: [],
    env: { FORCE_COLOR: "0", NO_COLOR: "1", TERM: "xterm-256color" },
    completion_pattern: AGENT_COMPLETION_PATTERN,
    input_mode: "stdin",
    display_mode: "agent",
    cols: 220,
    rows: 50,
    completion_timeout_ms: 1800000,
    idle_timeout_ms: 300000,
    error_pattern: RATE_LIMIT_PATTERN,
    settle_ms: 1200,
    max_output_bytes: 2097152,
  },
];

export type {
  ProviderConfig,
  ProviderDisplayMode,
  ProviderInputMode,
  ProvidersResponse,
  PtyAgentPayload,
  PtyCompletePayload,
  PtyDataPayload,
  PtyErrorPayload,
  PtyTaskRequest,
} from "./types";
