import React from "react";
import { Command } from "commander";
import path from "node:path";
import { execFile } from "node:child_process";
import {
  mkdir,
  writeFile,
  readFile,
  access,
  realpath,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { promisify } from "node:util";
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

const execFileAsync = promisify(execFile);

interface LegacyWorkspaceProject {
  id: string;
  name: string;
  root: string;
}

interface WorkspaceRegistryV2 {
  version: 2;
  projects: LegacyWorkspaceProject[];
}

interface WorkspaceRepository {
  id: string;
  name: string;
  sourceRoot: string;
  remoteUrl?: string | null;
  defaultBranch: string;
  kind: "local" | "cloned";
  createdAt: number;
  lastOpenedAt: number;
}

interface WorkspaceRepoBinding {
  repoId: string;
  branch: string;
  worktreePath: string;
  bindingKind: "existing-root" | "worktree";
}

interface WorkspaceEntry {
  id: string;
  name: string;
  repoBindings: WorkspaceRepoBinding[];
  activeRepoId: string;
  createdAt: number;
  lastOpenedAt: number;
}

interface WorkspaceRegistryV3 {
  version: 3;
  repositories: WorkspaceRepository[];
  workspaces: WorkspaceEntry[];
  openTabs: string[];
  activeWorkspaceId: string | null;
}

export interface ProjectContext {
  id?: string;
  name: string;
  root: string;
  source: "registry" | "adhoc" | "cwd";
  workspaceId?: string;
  repoId?: string;
}

interface ResolveProjectContextOptions {
  workspace?: string;
  repo?: string;
  worktreePolicy?: "workspace" | "node-isolated";
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
display_mode = "terminal"
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
display_mode = "agent"
completion_pattern = "(?m)(Task complete|Done|Finished|>\\\\s*$|^[\\\\s*✢✳✽✻✣✶✱✦✧✩✪✫⚡+·•◦°]*[A-Za-z][A-Za-z -]{1,40}(?:ed|ing)\\\\s+for\\\\s+(?:\\\\d+m\\\\s*)?\\\\d+s\\\\s*$)"
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
display_mode = "agent"
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
display_mode = "agent"
completion_pattern = "(?m)(Task complete|Done|Finished|>\\\\s*$|^[\\\\s*✢✳✽✻✣✶✱✦✧✩✪✫⚡+·•◦°]*[A-Za-z][A-Za-z -]{1,40}(?:ed|ing)\\\\s+for\\\\s+(?:\\\\d+m\\\\s*)?\\\\d+s\\\\s*$)"
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
): Promise<WorkspaceRegistryV2 | WorkspaceRegistryV3 | null> {
  const registryPath = workspaceRegistryPath(loomHome);
  if (!(await fileExists(registryPath))) {
    return null;
  }

  const parsed = JSON.parse(await readFile(registryPath, "utf8")) as {
    version?: unknown;
    projects?: unknown;
    repositories?: unknown;
    workspaces?: unknown;
    openTabs?: unknown;
    activeWorkspaceId?: unknown;
  };
  if (parsed.version !== 2 && parsed.version !== 3) {
    throw new Error(`unsupported workspace registry version in ${registryPath}`);
  }
  if (parsed.version === 3) {
    if (!Array.isArray(parsed.repositories) || !Array.isArray(parsed.workspaces)) {
      throw new Error(`invalid workspace registry format in ${registryPath}`);
    }
    return {
      version: 3,
      repositories: parsed.repositories.filter(isWorkspaceRepository),
      workspaces: parsed.workspaces.filter(isWorkspaceEntry),
      openTabs: Array.isArray(parsed.openTabs)
        ? parsed.openTabs.filter((id): id is string => typeof id === "string")
        : [],
      activeWorkspaceId:
        typeof parsed.activeWorkspaceId === "string" ? parsed.activeWorkspaceId : null,
    };
  }

  if (!Array.isArray(parsed.projects)) {
    throw new Error(`invalid workspace registry format in ${registryPath}`);
  }
  return {
    version: 2,
    projects: parsed.projects
      .filter((project: unknown): project is LegacyWorkspaceProject => {
        return (
          typeof project === "object" &&
          project !== null &&
          typeof (project as LegacyWorkspaceProject).id === "string" &&
          typeof (project as LegacyWorkspaceProject).name === "string" &&
          typeof (project as LegacyWorkspaceProject).root === "string"
        );
      }),
  };
}

function isWorkspaceRepository(value: unknown): value is WorkspaceRepository {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as WorkspaceRepository).id === "string" &&
    typeof (value as WorkspaceRepository).name === "string" &&
    typeof (value as WorkspaceRepository).sourceRoot === "string"
  );
}

function isWorkspaceEntry(value: unknown): value is WorkspaceEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as WorkspaceEntry).id === "string" &&
    typeof (value as WorkspaceEntry).name === "string" &&
    Array.isArray((value as WorkspaceEntry).repoBindings) &&
    typeof (value as WorkspaceEntry).activeRepoId === "string"
  );
}

async function resolveRegisteredProject(
  selector: string,
  repoSelector: string | undefined,
  loomHome = defaultLoomHome(),
): Promise<ProjectContext> {
  const registry = await loadWorkspaceRegistry(loomHome);
  const registryPath = workspaceRegistryPath(loomHome);
  if (!registry) {
    throw new Error(`workspace registry not found: ${registryPath}`);
  }

  if (registry.version === 2) {
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
      workspaceId: project.id,
    };
  }

  const workspace = registry.workspaces.find(
    (entry) => entry.id === selector || entry.name === selector,
  );
  if (!workspace) {
    throw new Error(`workspace not found in ${registryPath}: ${selector}`);
  }
  const binding = selectWorkspaceBinding(workspace, registry.repositories, repoSelector);
  const repository = registry.repositories.find((entry) => entry.id === binding.repoId);

  return {
    id: workspace.id,
    name: `${workspace.name}:${repository?.name ?? binding.repoId}`,
    root: await canonicalizeDirectory(binding.worktreePath),
    source: "registry",
    workspaceId: workspace.id,
    repoId: binding.repoId,
  };
}

function selectWorkspaceBinding(
  workspace: WorkspaceEntry,
  repositories: WorkspaceRepository[],
  repoSelector?: string,
): WorkspaceRepoBinding {
  if (repoSelector) {
    const repository = repositories.find(
      (entry) => entry.id === repoSelector || entry.name === repoSelector,
    );
    const repoId = repository?.id ?? repoSelector;
    const binding = workspace.repoBindings.find((item) => item.repoId === repoId);
    if (!binding) {
      throw new Error(`repository is not bound to workspace ${workspace.name}: ${repoSelector}`);
    }
    return binding;
  }
  const binding =
    workspace.repoBindings.find((item) => item.repoId === workspace.activeRepoId) ??
    workspace.repoBindings[0];
  if (!binding) {
    throw new Error(`workspace has no repository bindings: ${workspace.name}`);
  }
  return binding;
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

  const workspace =
    normalizeSelector(options.workspace) ??
    normalizeSelector(env.LOOM_WORKSPACE) ??
    normalizeSelector(options.project) ??
    normalizeSelector(env.LOOM_PROJECT);
  if (workspace) {
    return await resolveRegisteredProject(
      workspace,
      normalizeSelector(options.repo) ?? normalizeSelector(env.LOOM_REPO),
      loomHome,
    );
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

async function saveWorkspaceRegistry(
  registry: WorkspaceRegistryV3,
  loomHome = defaultLoomHome(),
): Promise<void> {
  await mkdir(loomHome, { recursive: true });
  await writeFile(workspaceRegistryPath(loomHome), JSON.stringify(registry, null, 2), "utf8");
}

async function ensureV3Registry(loomHome = defaultLoomHome()): Promise<WorkspaceRegistryV3> {
  const registry = await loadWorkspaceRegistry(loomHome);
  if (!registry) {
    return emptyV3Registry();
  }
  if (registry.version === 3) {
    return registry;
  }
  const now = Date.now();
  const migrated = registry.projects.map((project) => {
    const repoId = `repo_${project.id}`;
    const repository: WorkspaceRepository = {
      id: repoId,
      name: project.name,
      sourceRoot: project.root,
      remoteUrl: null,
      defaultBranch: "main",
      kind: "local",
      createdAt: now,
      lastOpenedAt: now,
    };
    const workspace: WorkspaceEntry = {
      id: project.id,
      name: project.name,
      repoBindings: [
        {
          repoId,
          branch: "main",
          worktreePath: project.root,
          bindingKind: "existing-root",
        },
      ],
      activeRepoId: repoId,
      createdAt: now,
      lastOpenedAt: now,
    };
    return { repository, workspace };
  });
  return {
    version: 3,
    repositories: migrated.map((item) => item.repository),
    workspaces: migrated.map((item) => item.workspace),
    openTabs: registry.projects.map((project) => project.id),
    activeWorkspaceId: registry.projects[0]?.id ?? null,
  };
}

function emptyV3Registry(): WorkspaceRegistryV3 {
  return {
    version: 3,
    repositories: [],
    workspaces: [],
    openTabs: [],
    activeWorkspaceId: null,
  };
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", root, ...args]);
  return stdout.toString().trim();
}

async function gitRoot(root: string): Promise<string> {
  return await git(root, ["rev-parse", "--show-toplevel"]);
}

async function gitRemote(root: string): Promise<string | null> {
  try {
    return await git(root, ["config", "--get", "remote.origin.url"]);
  } catch {
    return null;
  }
}

async function gitDefaultBranch(root: string): Promise<string> {
  try {
    const remoteHead = await git(root, ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"]);
    const [, branch] = remoteHead.split("/");
    if (branch) return branch;
  } catch {
    /* fall through */
  }
  try {
    return await git(root, ["symbolic-ref", "--short", "HEAD"]);
  } catch {
    return "main";
  }
}

async function gitRefExists(root: string, ref: string): Promise<boolean> {
  try {
    await execFileAsync("git", [
      "-C",
      root,
      "rev-parse",
      "--verify",
      "--quiet",
      `${ref}^{commit}`,
    ]);
    return true;
  } catch {
    return false;
  }
}

async function gitLocalBranchExists(root: string, branch: string): Promise<boolean> {
  return await gitRefExists(root, `refs/heads/${branch}`);
}

async function gitBranchMergedIntoHead(root: string, branch: string): Promise<boolean> {
  if (!(await gitLocalBranchExists(root, branch))) {
    return true;
  }
  try {
    await execFileAsync("git", [
      "-C",
      root,
      "merge-base",
      "--is-ancestor",
      `refs/heads/${branch}`,
      "HEAD",
    ]);
    return true;
  } catch {
    return false;
  }
}

async function gitStatusPorcelain(root: string): Promise<string> {
  return await git(root, ["status", "--porcelain"]);
}

async function deleteLocalBranchForCli(
  root: string,
  branch: string,
  force: boolean,
): Promise<void> {
  if (!(await gitLocalBranchExists(root, branch))) {
    return;
  }
  await execFileAsync("git", ["-C", root, "branch", force ? "-D" : "-d", branch]);
}

async function resolveGitBaseRef(root: string, preferred: string): Promise<string> {
  if (await gitRefExists(root, preferred)) {
    return preferred;
  }
  const origin = `origin/${preferred}`;
  if (await gitRefExists(root, origin)) {
    return origin;
  }
  return "HEAD";
}

async function registerLocalRepositoryForCli(
  root: string,
  kind: "local" | "cloned" = "local",
  name?: string,
  remoteUrl?: string | null,
): Promise<WorkspaceRepository> {
  const sourceRoot = await gitRoot(root);
  const now = Date.now();
  return {
    id: createRegistryId("repo"),
    name: name?.trim() || path.basename(sourceRoot) || sourceRoot,
    sourceRoot,
    remoteUrl: remoteUrl ?? (await gitRemote(sourceRoot)),
    defaultBranch: await gitDefaultBranch(sourceRoot),
    kind,
    createdAt: now,
    lastOpenedAt: now,
  };
}

async function cloneRepositoryForCli(url: string, name?: string): Promise<WorkspaceRepository> {
  const repoName = name?.trim() || nameFromGitUrl(url);
  const id = createRegistryId("repo");
  const target = path.join(defaultLoomHome(), "repos", `${slugify(repoName)}-${shortId(id)}`, "source");
  await mkdir(path.dirname(target), { recursive: true });
  await execFileAsync("git", ["clone", url, target]);
  const repository = await registerLocalRepositoryForCli(target, "cloned", repoName, url);
  return { ...repository, id };
}

function upsertCliRepository(
  repositories: WorkspaceRepository[],
  repository: WorkspaceRepository,
): WorkspaceRepository[] {
  const existing = repositories.find(
    (item) => item.id === repository.id || item.sourceRoot === repository.sourceRoot,
  );
  if (!existing) return [...repositories, repository];
  return repositories.map((item) =>
    item.id === existing.id ? { ...repository, id: existing.id } : item,
  );
}

async function createWorkspaceForCli(
  name: string,
  repoSelectors: string[],
): Promise<WorkspaceRegistryV3> {
  const registry = await ensureV3Registry();
  const id = createRegistryId("workspace");
  const now = Date.now();
  const bindings: WorkspaceRepoBinding[] = [];
  for (const selector of repoSelectors) {
    const repository = registry.repositories.find(
      (item) => item.id === selector || item.name === selector,
    );
    if (!repository) {
      throw new Error(`repository not found: ${selector}`);
    }
    const branch = `loom/${slugify(name)}/${slugify(repository.name)}-${shortId(id)}`;
    const worktreePath = path.join(
      defaultLoomHome(),
      "worktrees",
      repository.id,
      `${slugify(name)}-${shortId(id)}`,
    );
    await mkdir(path.dirname(worktreePath), { recursive: true });
    const baseRef = await resolveGitBaseRef(repository.sourceRoot, repository.defaultBranch);
    await execFileAsync("git", [
      "-C",
      repository.sourceRoot,
      "worktree",
      "add",
      "-b",
      branch,
      worktreePath,
      baseRef,
    ]);
    await ensureContextExcludedForCli(worktreePath);
    bindings.push({
      repoId: repository.id,
      branch,
      worktreePath,
      bindingKind: "worktree",
    });
  }
  const workspace: WorkspaceEntry = {
    id,
    name,
    repoBindings: bindings,
    activeRepoId: bindings[0]?.repoId ?? "",
    createdAt: now,
    lastOpenedAt: now,
  };
  const next = {
    ...registry,
    workspaces: [...registry.workspaces, workspace],
    openTabs: [...registry.openTabs, id],
    activeWorkspaceId: id,
  };
  await saveWorkspaceRegistry(next);
  return next;
}

async function removeWorkspaceForCli(
  selector: string,
  force: boolean,
): Promise<WorkspaceRegistryV3> {
  const registry = await ensureV3Registry();
  const workspace = registry.workspaces.find(
    (item) => item.id === selector || item.name === selector,
  );
  if (!workspace) {
    throw new Error(`workspace not found: ${selector}`);
  }
  const repositoriesById = new Map(registry.repositories.map((item) => [item.id, item]));

  for (const binding of workspace.repoBindings) {
    if (binding.bindingKind !== "worktree") {
      continue;
    }
    const repository = repositoriesById.get(binding.repoId);
    if (!repository) {
      throw new Error(`repository not found: ${binding.repoId}`);
    }
    if (!force) {
      const status = await gitStatusPorcelain(binding.worktreePath);
      if (status.length > 0) {
        throw new Error(`worktree has uncommitted changes: ${binding.worktreePath}`);
      }
      if (!(await gitBranchMergedIntoHead(repository.sourceRoot, binding.branch))) {
        throw new Error(`branch is not merged and cannot be safely deleted: ${binding.branch}`);
      }
    }
  }

  for (const binding of workspace.repoBindings) {
    if (binding.bindingKind !== "worktree") {
      continue;
    }
    const repository = repositoriesById.get(binding.repoId);
    if (!repository) {
      throw new Error(`repository not found: ${binding.repoId}`);
    }
    await execFileAsync("git", [
      "-C",
      repository.sourceRoot,
      "worktree",
      "remove",
      ...(force ? ["--force"] : []),
      binding.worktreePath,
    ]);
    await deleteLocalBranchForCli(repository.sourceRoot, binding.branch, force);
  }

  const openTabs = registry.openTabs.filter((id) => id !== workspace.id);
  const activeWorkspaceId =
    registry.activeWorkspaceId === workspace.id
      ? (openTabs[0] ?? null)
      : registry.activeWorkspaceId;
  const next = {
    ...registry,
    workspaces: registry.workspaces.filter((item) => item.id !== workspace.id),
    openTabs,
    activeWorkspaceId,
  };
  await saveWorkspaceRegistry(next);
  return next;
}

function createRegistryId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

async function ensureContextExcludedForCli(worktreePath: string): Promise<void> {
  await mkdir(path.join(worktreePath, ".context"), { recursive: true });
  const gitDirValue = await git(worktreePath, ["rev-parse", "--git-dir"]);
  const gitDir = path.isAbsolute(gitDirValue)
    ? gitDirValue
    : path.join(worktreePath, gitDirValue);
  const infoDir = path.join(gitDir, "info");
  const excludePath = path.join(infoDir, "exclude");
  await mkdir(infoDir, { recursive: true });
  const current = await readFile(excludePath, "utf8").catch(() => "");
  if (current.split(/\r?\n/).some((line) => line.trim() === ".context/")) {
    return;
  }
  const prefix = current.length > 0 && !current.endsWith("\n") ? `${current}\n` : current;
  await writeFile(excludePath, `${prefix}.context/\n`, "utf8");
}

function shortId(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, "").slice(-8) || Date.now().toString(36).slice(-8);
}

function nameFromGitUrl(url: string): string {
  return (url.trim().replace(/\/$/, "").split(/[/:]/).pop() ?? "repository").replace(/\.git$/, "");
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "workspace";
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

  const repo = program.command("repo").description("Manage Loom repositories");
  repo
    .command("add <path>")
    .description("Register a local git repository")
    .action(async (inputPath: string) => {
      const registry = await ensureV3Registry();
      const repository = await registerLocalRepositoryForCli(inputPath);
      const next = {
        ...registry,
        repositories: upsertCliRepository(registry.repositories, repository),
      };
      await saveWorkspaceRegistry(next);
      process.stdout.write(`${repository.id}\t${repository.name}\t${repository.sourceRoot}\n`);
    });

  repo
    .command("clone <url>")
    .description("Clone and register a git repository")
    .option("--name <name>", "repository name")
    .action(async (url: string, options: { name?: string }) => {
      const registry = await ensureV3Registry();
      const repository = await cloneRepositoryForCli(url, options.name);
      const next = {
        ...registry,
        repositories: upsertCliRepository(registry.repositories, repository),
      };
      await saveWorkspaceRegistry(next);
      process.stdout.write(`${repository.id}\t${repository.name}\t${repository.sourceRoot}\n`);
    });

  const workspace = program.command("workspace").description("Manage Loom workspaces");
  workspace
    .command("create <name>")
    .description("Create a workspace worktree for one or more repositories")
    .requiredOption("--repo <repo...>", "repository id or name")
    .action(async (name: string, options: { repo: string[] }) => {
      const registry = await createWorkspaceForCli(name, options.repo);
      process.stdout.write(`${registry.activeWorkspaceId ?? ""}\t${name}\n`);
    });

  workspace
    .command("remove <workspace>")
    .description("Remove a workspace worktree and its local branch")
    .option("--force", "remove dirty worktrees and delete unmerged branches")
    .action(async (workspaceSelector: string, options: { force?: boolean }) => {
      const registry = await removeWorkspaceForCli(workspaceSelector, Boolean(options.force));
      process.stdout.write(`${registry.activeWorkspaceId ?? ""}\n`);
    });

  program
    .command("run <prompt>")
    .description("Run a single prompt against a provider (use - for stdin, @file for a file)")
    .option("-p, --provider <name>", "provider name", "shell")
    .option("--workspace <nameOrId>", "workspace name or id")
    .option("--repo <nameOrId>", "repository name or id inside the workspace")
    .option("--worktree-policy <policy>", "workspace or node-isolated", "workspace")
    .option("--project <nameOrId>", "workspace project name or id")
    .option("--project-root <path>", "ad-hoc project root")
    .option("-w, --workdir <path>", "working directory")
    .action(
      async (
        rawPrompt: string,
        options: {
          provider: string;
          workspace?: string;
          repo?: string;
          worktreePolicy?: "workspace" | "node-isolated";
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
          workspace: options.workspace,
          repo: options.repo,
          worktreePolicy: options.worktreePolicy,
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
    .option("--workspace <nameOrId>", "workspace name or id")
    .option("--repo <nameOrId>", "repository name or id inside the workspace")
    .option("--worktree-policy <policy>", "workspace or node-isolated", "workspace")
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
          workspace?: string;
          repo?: string;
          worktreePolicy?: "workspace" | "node-isolated";
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
          workspace: options.workspace,
          repo: options.repo,
          worktreePolicy: options.worktreePolicy,
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
