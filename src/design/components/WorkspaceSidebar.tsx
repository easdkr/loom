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
  groupWorkspaceEntries,
  WORKSPACE_STATUS_LABEL,
  WORKSPACE_STATUS_ORDER,
  type WorkspaceStatusEntry,
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

function useWorkspaceDirtyState(projects: Project[]): [DirtyState, () => void] {
  const [dirtyState, setDirtyState] = useState<DirtyState>({});

  function refresh(): void {
    void Promise.all(
      projects.map((project) =>
        invoke<WorkspaceStatusResponse>("workspace_status", {
          request: { workspace_id: project.id },
        })
          .then((response) => [response.workspace_id, response.repositories.some((repo) => repo.dirty)] as const)
          .catch(() => [project.id, false] as const),
      ),
    ).then((entries) => {
      setDirtyState(Object.fromEntries(entries));
    });
  }

  useEffect(() => {
    if (projects.length === 0) {
      setDirtyState({});
      return;
    }
    refresh();
    const timer = window.setInterval(refresh, 60_000);
    return () => window.clearInterval(timer);
  }, [projects.map((project) => project.id).join(":")]);

  return [dirtyState, refresh];
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

export function WorkspaceSidebar() {
  const projects = useWorkspaceStore((state) => state.projects);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const pickAndAddProject = useWorkspaceStore((state) => state.pickAndAddProject);
  const cloneRepository = useWorkspaceStore((state) => state.cloneRepository);
  const [dirtyState, refreshDirtyState] = useWorkspaceDirtyState(projects);
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
        <span className="workspace-sidebar-title">Workspaces</span>
        <div className="workspace-sidebar-actions">
          <IconButton aria-label="Refresh workspace status" title="Refresh" onClick={refreshDirtyState}>
            ↻
          </IconButton>
          <IconButton aria-label="Add local repository" title="Add local repository" onClick={() => void pickAndAddProject()}>
            +
          </IconButton>
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
        {WORKSPACE_STATUS_ORDER.map((status, index) => (
          <StatusBucket
            key={status}
            status={status}
            projects={grouped[index]?.map((entry) => entry.project) ?? []}
            activeWorkspaceId={activeWorkspaceId}
            dirtyState={dirtyState}
          />
        ))}
      </div>
    </aside>
  );
}
