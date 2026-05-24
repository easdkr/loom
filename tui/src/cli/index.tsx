import React from "react";
import { Command } from "commander";
import path from "node:path";
import {
  mkdir,
  writeFile,
  readFile,
  access,
  realpath,
  stat,
} from "node:fs/promises";
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

interface WorkspaceProject {
  id: string;
  name: string;
  root: string;
}

interface WorkspaceRegistry {
  version: 2;
  projects: WorkspaceProject[];
}

export interface ProjectContext {
  id?: string;
  name: string;
  root: string;
  source: "registry" | "adhoc" | "cwd";
}

interface ResolveProjectContextOptions {
  project?: string;
  projectRoot?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  loomHome?: string;
}

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

function workspaceRegistryPath(loomHome = defaultLoomHome()): string {
  return path.join(loomHome, "workspace.json");
}

function normalizeSelector(value?: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

async function canonicalizeDirectory(inputPath: string): Promise<string> {
  const resolved = path.resolve(inputPath);
  const details = await stat(resolved).catch(() => null);
  if (!details) {
    throw new Error(`project root does not exist: ${resolved}`);
  }
  if (!details.isDirectory()) {
    throw new Error(`project root is not a directory: ${resolved}`);
  }
  return await realpath(resolved);
}

async function loadWorkspaceRegistry(
  loomHome = defaultLoomHome(),
): Promise<WorkspaceRegistry | null> {
  const registryPath = workspaceRegistryPath(loomHome);
  if (!(await fileExists(registryPath))) {
    return null;
  }

  const parsed = JSON.parse(await readFile(registryPath, "utf8")) as {
    version?: unknown;
    projects?: unknown;
  };
  if (parsed.version !== 2) {
    throw new Error(`unsupported workspace registry version in ${registryPath}`);
  }
  if (!Array.isArray(parsed.projects)) {
    throw new Error(`invalid workspace registry format in ${registryPath}`);
  }

  return {
    version: 2,
    projects: parsed.projects
      .filter((project): project is WorkspaceProject => {
        return (
          typeof project === "object" &&
          project !== null &&
          typeof (project as WorkspaceProject).id === "string" &&
          typeof (project as WorkspaceProject).name === "string" &&
          typeof (project as WorkspaceProject).root === "string"
        );
      }),
  };
}

async function resolveRegisteredProject(
  selector: string,
  loomHome = defaultLoomHome(),
): Promise<ProjectContext> {
  const registry = await loadWorkspaceRegistry(loomHome);
  const registryPath = workspaceRegistryPath(loomHome);
  if (!registry) {
    throw new Error(`workspace registry not found: ${registryPath}`);
  }

  const project = registry.projects.find(
    (entry) => entry.id === selector || entry.name === selector,
  );
  if (!project) {
    throw new Error(`project not found in ${registryPath}: ${selector}`);
  }

  return {
    id: project.id,
    name: project.name,
    root: await canonicalizeDirectory(project.root),
    source: "registry",
  };
}

async function resolveAdHocProject(inputPath: string): Promise<ProjectContext> {
  const root = await canonicalizeDirectory(inputPath);
  return {
    name: path.basename(root) || root,
    root,
    source: "adhoc",
  };
}

export async function resolveProjectContext(
  options: ResolveProjectContextOptions = {},
): Promise<ProjectContext> {
  const env = options.env ?? process.env;
  const loomHome = options.loomHome ?? defaultLoomHome();

  const projectRoot = normalizeSelector(options.projectRoot);
  if (projectRoot) {
    return await resolveAdHocProject(projectRoot);
  }

  const project = normalizeSelector(options.project) ?? normalizeSelector(env.LOOM_PROJECT);
  if (project) {
    return await resolveRegisteredProject(project, loomHome);
  }

  const envProjectRoot = normalizeSelector(env.LOOM_PROJECT_ROOT);
  if (envProjectRoot) {
    return await resolveAdHocProject(envProjectRoot);
  }

  const cwd = await canonicalizeDirectory(options.cwd ?? process.cwd());
  return {
    name: path.basename(cwd) || cwd,
    root: cwd,
    source: "cwd",
  };
}

export function resolveRunWorkdir(
  workdir: string | undefined,
  projectRoot: string,
): string {
  if (!workdir) {
    return projectRoot;
  }
  return path.isAbsolute(workdir) ? workdir : path.resolve(projectRoot, workdir);
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
    .option("--project <nameOrId>", "workspace project name or id")
    .option("--project-root <path>", "ad-hoc project root")
    .option("-w, --workdir <path>", "working directory")
    .action(
      async (
        rawPrompt: string,
        options: {
          provider: string;
          project?: string;
          projectRoot?: string;
          workdir?: string;
        },
      ) => {
        const prompt = await readPromptArgument(rawPrompt);
        if (prompt.length === 0) {
          throw new Error("prompt is empty");
        }
        const { providers, configPath } = await ensureProviders();
        const provider = findProvider(providers, options.provider);
        const project = await resolveProjectContext({
          project: options.project,
          projectRoot: options.projectRoot,
        });
        const handle = renderApp(
          <RunSingle
            provider={provider}
            prompt={prompt}
            workdir={resolveRunWorkdir(options.workdir, project.root)}
            configPath={configPath}
            project={project}
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
    .option("--project <nameOrId>", "workspace project name or id")
    .option("--project-root <path>", "ad-hoc project root")
    .option("-y, --yes", "skip review and execute immediately")
    .option("-r, --run-id <id>", "explicit run id")
    .action(
      async (
        rawPrompt: string,
        options: {
          template?: string;
          provider?: string;
          project?: string;
          projectRoot?: string;
          yes?: boolean;
          runId?: string;
        },
      ) => {
        const prompt = await readPromptArgument(rawPrompt);
        if (prompt.length === 0) {
          throw new Error("prompt is empty");
        }
        const { providers, configPath } = await ensureProviders();
        const project = await resolveProjectContext({
          project: options.project,
          projectRoot: options.projectRoot,
        });
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
            project={project}
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
