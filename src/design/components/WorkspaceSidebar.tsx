import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Project } from "@core/index";
import {
  closeProjectTab,
  getExecutionStore,
  removeProjectFromWorkspace,
  useProjectExecutionStatus,
  useWorkspaceStore,
  type WorkspaceDerivedStatus,
} from "@stores/index";
import { Badge } from "./Badge";
import { IconButton } from "./Button";
import {
  ALL_REPOSITORIES_FILTER_ID,
  buildRepositoryWorktreeView,
  groupWorkspaceEntries,
  parseWorkspaceSidebarViewMode,
  WORKSPACE_STATUS_LABEL,
  WORKSPACE_STATUS_ORDER,
  WORKSPACE_SIDEBAR_VIEW_STORAGE_KEY,
  workspaceDirtyKey,
  type RepositoryWorktreeEntry,
  type RepositoryWorktreeView,
  type WorkspaceStatusEntry,
  type WorkspaceSidebarViewMode,
} from "./workspaceSidebarModel";

interface WorkspaceStatusResponse {
  workspace_id: string;
  repositories: { repo_id: string; dirty: boolean; status: string; worktree_path: string }[];
}

type DirtyState = Record<string, boolean>;

function relativeTimeLabel(timestamp: number): string {
  const elapsed = Math.max(0, Date.now() - timestamp);
  const minute = 60_000;
  const hour = minute * 60;
  const day = hour * 24;
  if (elapsed < minute) return "now";
  if (elapsed < hour) return `${Math.floor(elapsed / minute)}m`;
  if (elapsed < day) return `${Math.floor(elapsed / hour)}h`;
  return `${Math.floor(elapsed / day)}d`;
}

function shortenedPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.slice(-3).join("/") || path;
}

function readInitialViewMode(): WorkspaceSidebarViewMode {
  if (typeof window === "undefined") {
    return "status";
  }
  return parseWorkspaceSidebarViewMode(window.localStorage.getItem(WORKSPACE_SIDEBAR_VIEW_STORAGE_KEY));
}

function WorkspaceRow({
  project,
  active,
  dirty,
}: {
  project: Project;
  active: boolean;
  dirty: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const status = useProjectExecutionStatus(project.id);
  const setActiveWorkspace = useWorkspaceStore((state) => state.setActiveWorkspace);
  const openWorkspace = useWorkspaceStore((state) => state.openWorkspace);
  const setActiveRepository = useWorkspaceStore((state) => state.setActiveRepository);
  const repositories = useWorkspaceStore((state) => state.repositories);
  const activeRepository = project.activeRepository;
  const statusLabel = WORKSPACE_STATUS_LABEL[status];

  function activate(): void {
    openWorkspace(project.id);
    setActiveWorkspace(project.id);
    if (status === "review") {
      getExecutionStore(project.id).getState().setHumanReviewOpen(true);
    }
  }

  async function remove(force: boolean): Promise<void> {
    const label = force ? "강제로 제거" : "제거";
    const confirmed = window.confirm(
      `${project.name} workspace를 ${label}할까요?\n\nworktree 디렉터리와 local branch가 삭제됩니다.`,
    );
    if (!confirmed) return;
    try {
      await removeProjectFromWorkspace(project.id, force);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="workspace-row-shell" data-status={status} data-active={active ? "true" : "false"}>
      <button
        type="button"
        className="workspace-row"
        data-active={active ? "true" : "false"}
        data-status={status}
        title={project.root}
        onClick={activate}
      >
        <span className="workspace-row-stripe" aria-hidden />
        <span
          className="workspace-row-status"
          title={statusLabel}
          aria-label={`Status: ${statusLabel}`}
        />
        <span className="workspace-row-main">
          <span className="workspace-row-name">{project.name}</span>
          <span className="workspace-row-meta">
            {activeRepository?.name ?? project.activeRepoId} · {project.displayBranch}
          </span>
        </span>
        <span className="workspace-row-badges">
          <Badge tone={project.mode === "plan" ? "accent" : "neutral"}>{project.mode ?? "plan"}</Badge>
          <Badge tone="neutral">{project.repoCount}</Badge>
          {dirty ? <span className="workspace-row-dirty" title="Dirty worktree">dirty</span> : null}
        </span>
        <span className="workspace-row-time">{relativeTimeLabel(project.lastOpenedAt)}</span>
      </button>
      <div className="workspace-row-actions">
        <IconButton
          aria-label={expanded ? "Collapse repositories" : "Expand repositories"}
          title={expanded ? "Collapse repositories" : "Expand repositories"}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? "▴" : "▾"}
        </IconButton>
        <IconButton
          aria-label={`Close ${project.name}`}
          title="Close workspace"
          onClick={() => void closeProjectTab(project.id)}
        >
          ×
        </IconButton>
        <IconButton
          aria-label={`Remove ${project.name}`}
          title="Remove workspace"
          onClick={() => void remove(false)}
        >
          −
        </IconButton>
      </div>
      {expanded ? (
        <div className="workspace-repo-list">
          {project.repoBindings.map((binding) => {
            const repository = repositories.find((item) => item.id === binding.repoId);
            const selected = binding.repoId === project.activeRepoId;
            return (
              <button
                key={binding.repoId}
                type="button"
                className="workspace-repo-row"
                data-active={selected ? "true" : "false"}
                title={binding.worktreePath}
                onClick={() => {
                  openWorkspace(project.id);
                  setActiveWorkspace(project.id);
                  setActiveRepository(project.id, binding.repoId);
                }}
              >
                <span className="workspace-repo-dot" aria-hidden />
                <span className="workspace-repo-copy">
                  <span className="workspace-repo-name">{repository?.name ?? binding.repoId}</span>
                  <span className="workspace-repo-branch">{binding.branch}</span>
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function WorkspaceStatusTracker({
  projectId,
  onStatus,
}: {
  projectId: string;
  onStatus: (projectId: string, status: WorkspaceDerivedStatus) => void;
}) {
  const status = useProjectExecutionStatus(projectId);
  useEffect(() => {
    onStatus(projectId, status);
  }, [onStatus, projectId, status]);
  return null;
}

function useWorkspaceDirtyState(projects: Project[]): [DirtyState, DirtyState, () => void] {
  const [dirtyState, setDirtyState] = useState<DirtyState>({});
  const [dirtyByWorktree, setDirtyByWorktree] = useState<DirtyState>({});

  function refresh(): void {
    void Promise.all(
      projects.map((project) =>
        invoke<WorkspaceStatusResponse>("workspace_status", {
          request: { workspace_id: project.id },
        })
          .then((response) => ({
            workspaceId: response.workspace_id,
            repositories: response.repositories,
            dirty: response.repositories.some((repo) => repo.dirty),
          }))
          .catch(() => ({
            workspaceId: project.id,
            repositories: [],
            dirty: false,
          })),
      ),
    ).then((responses) => {
      setDirtyState(Object.fromEntries(responses.map((response) => [response.workspaceId, response.dirty])));
      setDirtyByWorktree(
        Object.fromEntries(
          responses.flatMap((response) =>
            response.repositories.map((repo) => [
              workspaceDirtyKey(response.workspaceId, repo.repo_id, repo.worktree_path),
              repo.dirty,
            ]),
          ),
        ),
      );
    });
  }

  useEffect(() => {
    if (projects.length === 0) {
      setDirtyState({});
      setDirtyByWorktree({});
      return;
    }
    refresh();
    const timer = window.setInterval(refresh, 60_000);
    return () => window.clearInterval(timer);
  }, [projects.map((project) => project.id).join(":")]);

  return [dirtyState, dirtyByWorktree, refresh];
}

function StatusBucket({
  status,
  projects,
  activeWorkspaceId,
  dirtyState,
}: {
  status: WorkspaceDerivedStatus;
  projects: Project[];
  activeWorkspaceId: string | null;
  dirtyState: DirtyState;
}) {
  const [collapsed, setCollapsed] = useState(projects.length === 0);

  useEffect(() => {
    if (projects.length > 0) {
      setCollapsed(false);
    }
  }, [projects.length]);

  return (
    <section className="workspace-group">
      <button
        type="button"
        className="workspace-group-header"
        onClick={() => setCollapsed((value) => !value)}
      >
        <span className="workspace-group-caret" data-collapsed={collapsed ? "true" : "false"}>
          ▾
        </span>
        <span>{WORKSPACE_STATUS_LABEL[status]}</span>
        <Badge tone={status === "review" ? "accent" : "neutral"}>{projects.length}</Badge>
      </button>
      {!collapsed ? (
        <div className="workspace-group-list">
          {projects.map((project) => (
            <WorkspaceRow
              key={project.id}
              project={project}
              active={project.id === activeWorkspaceId}
              dirty={Boolean(dirtyState[project.id])}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ViewToggle({
  value,
  onChange,
}: {
  value: WorkspaceSidebarViewMode;
  onChange: (value: WorkspaceSidebarViewMode) => void;
}) {
  return (
    <div className="workspace-view-toggle" role="tablist" aria-label="Workspace sidebar view">
      {(["status", "repository"] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          className="workspace-view-toggle-item"
          data-active={value === mode ? "true" : "false"}
          onClick={() => onChange(mode)}
        >
          {mode === "status" ? "Status" : "Repos"}
        </button>
      ))}
    </div>
  );
}

function RepositoryChipBar({
  view,
  onSelect,
}: {
  view: RepositoryWorktreeView;
  onSelect: (repoId: string) => void;
}) {
  return (
    <div className="repository-chip-row" aria-label="Repository filter">
      {view.chips.map((chip) => (
        <button
          key={chip.id}
          type="button"
          className="repository-chip"
          data-active={view.selectedRepositoryId === chip.id ? "true" : "false"}
          onClick={() => onSelect(chip.id)}
        >
          <span className="repository-chip-label">{chip.label}</span>
          <span className="repository-chip-count">{chip.worktreeCount}</span>
          {chip.running ? <span className="repository-chip-dot" data-tone="running" title="Running" /> : null}
          {chip.dirty ? <span className="repository-chip-dot" data-tone="dirty" title="Dirty" /> : null}
        </button>
      ))}
    </div>
  );
}

function WorktreeRow({
  entry,
  active,
  onDeleted,
}: {
  entry: RepositoryWorktreeEntry;
  active: boolean;
  onDeleted: () => void;
}) {
  const openWorkspace = useWorkspaceStore((state) => state.openWorkspace);
  const setActiveWorkspace = useWorkspaceStore((state) => state.setActiveWorkspace);
  const setActiveRepository = useWorkspaceStore((state) => state.setActiveRepository);
  const removeWorkspaceWorktree = useWorkspaceStore((state) => state.removeWorkspaceWorktree);
  const statusLabel = WORKSPACE_STATUS_LABEL[entry.status];

  function activate(): void {
    openWorkspace(entry.workspace.id);
    setActiveWorkspace(entry.workspace.id);
    setActiveRepository(entry.workspace.id, entry.binding.repoId);
    if (entry.status === "review") {
      getExecutionStore(entry.workspace.id).getState().setHumanReviewOpen(true);
    }
  }

  async function removeWorktree(): Promise<void> {
    const confirmed = window.confirm(
      `${entry.workspace.name} worktree를 제거할까요?\n\n${entry.binding.worktreePath}\n\nworktree 디렉터리와 local branch가 삭제됩니다.`,
    );
    if (!confirmed) return;
    try {
      await removeWorkspaceWorktree(
        entry.workspace.id,
        entry.binding.repoId,
        entry.binding.worktreePath,
        false,
      );
      onDeleted();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const forceConfirmed = window.confirm(`${message}\n\n강제로 제거할까요?`);
      if (!forceConfirmed) return;
      try {
        await removeWorkspaceWorktree(
          entry.workspace.id,
          entry.binding.repoId,
          entry.binding.worktreePath,
          true,
        );
        onDeleted();
      } catch (forceError) {
        window.alert(forceError instanceof Error ? forceError.message : String(forceError));
      }
    }
  }

  return (
    <div className="worktree-row-shell" data-active={active ? "true" : "false"}>
      <button
        type="button"
        className="worktree-row"
        data-status={entry.status}
        title={entry.binding.worktreePath}
        onClick={activate}
      >
        <span className="workspace-row-stripe" aria-hidden />
        <span
          className="workspace-row-status"
          title={statusLabel}
          aria-label={`Status: ${statusLabel}`}
        />
        <span className="workspace-row-main">
          <span className="workspace-row-name">{entry.workspace.name}</span>
          <span className="workspace-row-meta">
            {entry.binding.branch} · {shortenedPath(entry.binding.worktreePath)}
          </span>
        </span>
        <span className="workspace-row-badges">
          {entry.showRepositoryBadge ? <Badge tone="neutral">{entry.repository?.name ?? entry.binding.repoId}</Badge> : null}
          <Badge tone={entry.workspace.mode === "plan" ? "accent" : "neutral"}>{entry.workspace.mode ?? "plan"}</Badge>
          {entry.dirty ? <span className="workspace-row-dirty" title="Dirty worktree">dirty</span> : null}
        </span>
        <span className="workspace-row-time">{relativeTimeLabel(entry.workspace.lastOpenedAt)}</span>
      </button>
      {entry.binding.bindingKind === "worktree" ? (
        <div className="workspace-row-actions">
          <IconButton
            aria-label={`Remove ${entry.workspace.name} worktree`}
            title="Remove worktree"
            onClick={() => void removeWorktree()}
          >
            -
          </IconButton>
        </div>
      ) : null}
    </div>
  );
}

function RepositoryDeck({
  view,
  activeWorkspaceId,
  onSelectRepository,
  onDeleted,
}: {
  view: RepositoryWorktreeView;
  activeWorkspaceId: string | null;
  onSelectRepository: (repoId: string) => void;
  onDeleted: () => void;
}) {
  return (
    <div className="repository-deck">
      <RepositoryChipBar view={view} onSelect={onSelectRepository} />
      <div className="worktree-list">
        {view.entries.map((entry) => (
          <WorktreeRow
            key={`${entry.workspace.id}:${entry.binding.repoId}:${entry.binding.worktreePath}`}
            entry={entry}
            active={activeWorkspaceId === entry.workspace.id && entry.workspace.activeRepoId === entry.binding.repoId}
            onDeleted={onDeleted}
          />
        ))}
      </div>
    </div>
  );
}

export function WorkspaceSidebar() {
  const projects = useWorkspaceStore((state) => state.projects);
  const repositories = useWorkspaceStore((state) => state.repositories);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const pickAndAddProject = useWorkspaceStore((state) => state.pickAndAddProject);
  const cloneRepository = useWorkspaceStore((state) => state.cloneRepository);
  const createWorkspace = useWorkspaceStore((state) => state.createWorkspace);
  const [viewMode, setViewMode] = useState<WorkspaceSidebarViewMode>(readInitialViewMode);
  const [selectedRepositoryId, setSelectedRepositoryId] = useState(ALL_REPOSITORIES_FILTER_ID);
  const [dirtyState, dirtyByWorktree, refreshDirtyState] = useWorkspaceDirtyState(projects);
  const [statusByProject, setStatusByProject] = useState<Record<string, WorkspaceDerivedStatus>>({});
  const statusEntries = useMemo<WorkspaceStatusEntry[]>(
    () =>
      projects.map((project) => ({
        project,
        status: statusByProject[project.id] ?? "idle",
      })),
    [projects, statusByProject],
  );
  const grouped = useMemo(() => groupWorkspaceEntries(statusEntries), [statusEntries]);
  const repositoryView = useMemo(
    () =>
      buildRepositoryWorktreeView({
        projects,
        repositories,
        selectedRepositoryId,
        dirtyByWorktree,
        statusByProject,
      }),
    [dirtyByWorktree, projects, repositories, selectedRepositoryId, statusByProject],
  );

  useEffect(() => {
    window.localStorage.setItem(WORKSPACE_SIDEBAR_VIEW_STORAGE_KEY, viewMode);
  }, [viewMode]);

  useEffect(() => {
    if (repositoryView.selectedRepositoryId !== selectedRepositoryId) {
      setSelectedRepositoryId(repositoryView.selectedRepositoryId);
    }
  }, [repositoryView.selectedRepositoryId, selectedRepositoryId]);

  async function createWorktreeForSelectedRepository(): Promise<void> {
    if (repositoryView.selectedRepositoryId === ALL_REPOSITORIES_FILTER_ID) {
      return;
    }
    const repository = repositories.find((item) => item.id === repositoryView.selectedRepositoryId);
    const name = window.prompt("Workspace name", repository?.name ? `${repository.name} workspace` : "workspace");
    if (!name?.trim()) {
      return;
    }
    try {
      await createWorkspace(name.trim(), [repositoryView.selectedRepositoryId]);
      refreshDirtyState();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <aside className="workspace-sidebar" aria-label="Workspaces">
      {projects.map((project) => (
        <WorkspaceStatusTracker
          key={project.id}
          projectId={project.id}
          onStatus={(projectId, status) =>
            setStatusByProject((current) =>
              current[projectId] === status ? current : { ...current, [projectId]: status },
            )
          }
        />
      ))}
      <header className="workspace-sidebar-header">
        <span className="workspace-sidebar-title">{viewMode === "repository" ? "Worktrees" : "Workspaces"}</span>
        <div className="workspace-sidebar-actions">
          <IconButton aria-label="Refresh workspace status" title="Refresh" onClick={refreshDirtyState}>
            ↻
          </IconButton>
          {viewMode === "repository" ? (
            <IconButton
              aria-label="Create worktree"
              title={
                repositoryView.selectedRepositoryId === ALL_REPOSITORIES_FILTER_ID
                  ? "Select a repository first"
                  : "Create worktree"
              }
              disabled={repositoryView.selectedRepositoryId === ALL_REPOSITORIES_FILTER_ID}
              onClick={() => void createWorktreeForSelectedRepository()}
            >
              +
            </IconButton>
          ) : (
            <IconButton aria-label="Add local repository" title="Add local repository" onClick={() => void pickAndAddProject()}>
              +
            </IconButton>
          )}
          <IconButton
            aria-label="Clone repository"
            title="Clone repository"
            onClick={() => {
              const url = window.prompt("Git URL");
              if (url?.trim()) {
                void cloneRepository(url.trim());
              }
            }}
          >
            ⎘
          </IconButton>
        </div>
      </header>
      <div className="workspace-sidebar-body">
        <ViewToggle value={viewMode} onChange={setViewMode} />
        {viewMode === "repository" ? (
          <RepositoryDeck
            view={repositoryView}
            activeWorkspaceId={activeWorkspaceId}
            onSelectRepository={setSelectedRepositoryId}
            onDeleted={refreshDirtyState}
          />
        ) : (
          WORKSPACE_STATUS_ORDER.map((status, index) => (
            <StatusBucket
              key={status}
              status={status}
              projects={grouped[index]?.map((entry) => entry.project) ?? []}
              activeWorkspaceId={activeWorkspaceId}
              dirtyState={dirtyState}
            />
          ))
        )}
      </div>
    </aside>
  );
}
