import React from "react";
import { Command } from "commander";
import path from "node:path";
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { homedir } from "node:os";
import { renderApp } from "./render.js";
import { ProvidersList } from "./commands/providers.js";
import { RunSingle } from "./commands/run.js";
import { PlanMode } from "./commands/plan.js";
import { InitResult } from "./commands/init.js";
import {
  findProvider,
  loadProviderConfigs,
  providersConfigPath,
} from "../pty/providerLoader.js";
import { generatePlan, defaultTemplates } from "../plan/generatePlan.js";
import { fallbackProviders } from "../../../src/providers/index.js";
import type { ProviderConfig } from "../../../src/providers/types.js";

const DEFAULT_PROVIDERS_TOML = `[[providers]]
name = "shell"
type = "pty"
command = "/bin/zsh"
args = ["-lc"]
input_mode = "append-arg"
completion_pattern = "(?m)^LOOM_EXIT:\\\\d+\\\\r?$"
cols = 220
rows = 50
completion_timeout_ms = 120000
idle_timeout_ms = 30000
env = { FORCE_COLOR = "0", NO_COLOR = "1", TERM = "xterm-256color" }

[[providers]]
name = "claude-code"
type = "pty"
command = "claude"
args = ["--permission-mode", "bypassPermissions"]
input_mode = "append-arg"
completion_pattern = "(?m)(Task complete|Done|Finished|>\\\\s*$)"
cols = 220
rows = 50
completion_timeout_ms = 1800000
idle_timeout_ms = 300000
env = { FORCE_COLOR = "0", NO_COLOR = "1", TERM = "xterm-256color" }

[[providers]]
name = "codex"
type = "pty"
command = "codex"
args = ["exec", "--sandbox", "workspace-write", "--skip-git-repo-check", "--color", "never"]
input_mode = "append-arg"
completion_pattern = "(?m)(Task complete|Done|Finished)"
cols = 220
rows = 50
completion_timeout_ms = 1800000
idle_timeout_ms = 300000
env = { FORCE_COLOR = "0", NO_COLOR = "1", TERM = "xterm-256color" }

[[providers]]
name = "cursor"
type = "pty"
command = "cursor-agent"
args = []
input_mode = "stdin"
completion_pattern = "(?m)(Task complete|Done|Finished|>\\\\s*$)"
cols = 220
rows = 50
completion_timeout_ms = 1800000
idle_timeout_ms = 300000
env = { FORCE_COLOR = "0", NO_COLOR = "1", TERM = "xterm-256color" }
`;

async function readPromptArgument(input: string): Promise<string> {
  if (input === "-") {
    const chunks: Buffer[] = [];
    return await new Promise<string>((resolve, reject) => {
      process.stdin.on("data", (chunk) => chunks.push(chunk as Buffer));
      process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8").trim()));
      process.stdin.on("error", reject);
    });
  }
  if (input.startsWith("@")) {
    const file = input.slice(1);
    return (await readFile(file, "utf8")).trim();
  }
  return input;
}

function defaultLoomHome(): string {
  return path.join(homedir(), ".loom");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureProviders(): Promise<{
  providers: ProviderConfig[];
  configPath: string;
}> {
  try {
    const providers = await loadProviderConfigs();
    return { providers, configPath: providersConfigPath() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `warn: failed to load ${providersConfigPath()}; using built-in defaults (${message})\n`,
    );
    return { providers: fallbackProviders, configPath: providersConfigPath() };
  }
}

function buildProgram(): Command {
  const program = new Command();
  program
    .name("loom")
    .description("PTY-based local AI agent orchestrator (TUI adapter)")
    .version("0.1.0");

  program
    .command("providers")
    .description("List configured providers")
    .action(async () => {
      const { providers, configPath } = await ensureProviders();
      const handle = renderApp(
        <ProvidersList providers={providers} configPath={configPath} />,
      );
      await handle.done;
    });

  program
    .command("init")
    .description(
      `Write a default providers.toml to ${path.join("~", ".loom", "providers.toml")} if missing`,
    )
    .option("--force", "overwrite the existing config")
    .action(async (options: { force?: boolean }) => {
      const targetDir = defaultLoomHome();
      const targetPath = path.join(targetDir, "providers.toml");
      const exists = await fileExists(targetPath);
      let created = false;
      if (!exists || options.force) {
        await mkdir(targetDir, { recursive: true });
        await writeFile(targetPath, DEFAULT_PROVIDERS_TOML, "utf8");
        created = true;
      }
      const handle = renderApp(
        <InitResult
          configPath={targetPath}
          created={created}
          preview={DEFAULT_PROVIDERS_TOML}
        />,
      );
      await handle.done;
    });

  program
    .command("run <prompt>")
    .description("Run a single prompt against a provider (use - for stdin, @file for a file)")
    .option("-p, --provider <name>", "provider name", "shell")
    .option("-w, --workdir <path>", "working directory")
    .action(
      async (
        rawPrompt: string,
        options: { provider: string; workdir?: string },
      ) => {
        const prompt = await readPromptArgument(rawPrompt);
        if (prompt.length === 0) {
          throw new Error("prompt is empty");
        }
        const { providers, configPath } = await ensureProviders();
        const provider = findProvider(providers, options.provider);
        const handle = renderApp(
          <RunSingle
            provider={provider}
            prompt={prompt}
            workdir={options.workdir}
            configPath={configPath}
          />,
        );
        await handle.done;
      },
    );

  program
    .command("plan <prompt>")
    .description(
      "Generate a basic plan, review it interactively, then execute (use - for stdin, @file for file)",
    )
    .option(
      "-t, --template <name>",
      `plan template (${defaultTemplates().join("|")})`,
      "default",
    )
    .option("-p, --provider <name>", "preferred provider for design step")
    .option("-y, --yes", "skip review and execute immediately")
    .option("-r, --run-id <id>", "explicit run id")
    .action(
      async (
        rawPrompt: string,
        options: {
          template?: string;
          provider?: string;
          yes?: boolean;
          runId?: string;
        },
      ) => {
        const prompt = await readPromptArgument(rawPrompt);
        if (prompt.length === 0) {
          throw new Error("prompt is empty");
        }
        const { providers, configPath } = await ensureProviders();
        const draft = generatePlan({
          origin: prompt,
          providers,
          template: options.template,
          preferredProvider: options.provider,
        });
        const handle = renderApp(
          <PlanMode
            initialDraft={draft}
            providers={providers}
            configPath={configPath}
            autoApprove={options.yes}
            runIdPrefix={options.runId}
          />,
        );
        await handle.done;
      },
    );

  return program;
}

export async function main(argv: string[]): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(argv);
}
