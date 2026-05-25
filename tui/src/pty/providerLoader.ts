import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  defaultDisplayModeForProvider,
  fallbackProviders,
} from "../../../src/providers/index.js";
import type { ProviderConfig } from "../../../src/providers/types.js";

export function providersConfigPath(): string {
  return join(homedir(), ".loom", "providers.toml");
}

export async function loadProviderConfigs(): Promise<ProviderConfig[]> {
  const path = providersConfigPath();
  const merged = new Map<string, ProviderConfig>(
    fallbackProviders.map((p) => [p.name, p]),
  );

  let userToml: string | null = null;
  try {
    userToml = await readFile(path, "utf8");
  } catch {
    return Array.from(merged.values());
  }

  for (const provider of parseProvidersToml(userToml)) {
    merged.set(provider.name, provider);
  }
  return Array.from(merged.values());
}

export function findProvider(
  providers: ProviderConfig[],
  name: string,
): ProviderConfig {
  const found = providers.find((p) => p.name === name);
  if (!found) {
    throw new Error(`unknown provider: ${name}`);
  }
  return found;
}

export function validateProviderForExecution(provider: ProviderConfig): void {
  const exe = provider.command.split(/[\\/]/).pop() ?? provider.command;
  if (
    exe === "claude" &&
    provider.args.some((arg) => arg === "--print" || arg === "-p")
  ) {
    throw new Error(
      "claude --print is forbidden for Loom PTY execution; use interactive claude instead",
    );
  }
}

interface ParsedProvider extends Partial<ProviderConfig> {
  name?: string;
}

export function parseProvidersToml(source: string): ProviderConfig[] {
  const providers: ParsedProvider[] = [];
  let current: ParsedProvider | null = null;
  const lines = source.split(/\r?\n/);

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    if (line === "[[providers]]") {
      if (current && current.name) {
        providers.push(current);
      }
      current = {};
      continue;
    }
    if (!current) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    assignTomlField(current, key, value);
  }

  if (current && current.name) {
    providers.push(current);
  }

  return providers.map((p) => withDefaults(p));
}

function assignTomlField(target: ParsedProvider, key: string, value: string) {
  if (value.startsWith("[")) {
    (target as Record<string, unknown>)[key] = parseTomlArray(value);
    return;
  }
  if (value.startsWith("{")) {
    (target as Record<string, unknown>)[key] = parseTomlInlineTable(value);
    return;
  }
  if (value.startsWith('"') || value.startsWith("'")) {
    (target as Record<string, unknown>)[key] = unquote(value);
    return;
  }
  if (/^-?\d+$/.test(value)) {
    (target as Record<string, unknown>)[key] = Number(value);
    return;
  }
  if (value === "true" || value === "false") {
    (target as Record<string, unknown>)[key] = value === "true";
    return;
  }
  (target as Record<string, unknown>)[key] = value;
}

function parseTomlArray(input: string): string[] {
  const inner = input.replace(/^\[/, "").replace(/\]$/, "").trim();
  if (!inner) return [];
  return splitTopLevel(inner, ",").map((item) => unquote(item.trim()));
}

function parseTomlInlineTable(input: string): Record<string, string> {
  const inner = input.replace(/^{/, "").replace(/}$/, "").trim();
  const out: Record<string, string> = {};
  if (!inner) return out;
  for (const pair of splitTopLevel(inner, ",")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const k = pair.slice(0, eq).trim();
    const v = unquote(pair.slice(eq + 1).trim());
    out[k] = v;
  }
  return out;
}

function splitTopLevel(input: string, separator: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inString: '"' | "'" | null = null;
  let buf = "";
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inString) {
      buf += ch;
      if (ch === inString && input[i - 1] !== "\\") {
        inString = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      buf += ch;
      continue;
    }
    if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") depth--;
    if (ch === separator && depth === 0) {
      out.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim().length > 0) out.push(buf);
  return out;
}

function unquote(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

function withDefaults(p: ParsedProvider): ProviderConfig {
  return {
    name: p.name ?? "unknown",
    type: (p.type as ProviderConfig["type"]) ?? "pty",
    command: p.command ?? "",
    args: p.args ?? [],
    env: (p.env ?? {}) as Record<string, string>,
    completion_pattern: p.completion_pattern ?? "",
    input_mode: (p.input_mode as ProviderConfig["input_mode"]) ?? "stdin",
    display_mode:
      (p.display_mode as ProviderConfig["display_mode"]) ??
      defaultDisplayModeForProvider({
        name: p.name ?? "unknown",
        command: p.command ?? "",
      }),
    cols: p.cols ?? 220,
    rows: p.rows ?? 50,
    completion_timeout_ms: p.completion_timeout_ms ?? 30 * 60 * 1000,
    idle_timeout_ms: p.idle_timeout_ms ?? 5 * 60 * 1000,
  };
}
