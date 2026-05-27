import {
  closeProjectTab,
  removeProjectFromWorkspace,
  useProjectExecutionStatus,
  useWorkspaceStore,
} from "@stores/index";
import type { Project } from "@core/index";
import type { DragEvent, MouseEvent } from "react";

interface ProjectTabProps {
  project: Project;
  active: boolean;
}

function ProjectTab({ project, active }: ProjectTabProps) {
  const status = useProjectExecutionStatus(project.id);
  const setActiveTab = useWorkspaceStore((state) => state.setActiveTab);
  const closeOtherTabs = useWorkspaceStore((state) => state.closeOtherTabs);
  const renameProject = useWorkspaceStore((state) => state.renameProject);
  const reorderTabs = useWorkspaceStore((state) => state.reorderTabs);
  const openTabs = useWorkspaceStore((state) => state.openTabs);

  function handleDragStart(event: DragEvent<HTMLButtonElement>): void {
    event.dataTransfer.setData("text/plain", project.id);
    event.dataTransfer.effectAllowed = "move";
  }

  function handleDrop(event: DragEvent<HTMLButtonElement>): void {
    event.preventDefault();
    const sourceId = event.dataTransfer.getData("text/plain");
    if (!sourceId || sourceId === project.id) {
      return;
    }
    const next = openTabs.filter((id) => id !== sourceId);
    const targetIndex = next.indexOf(project.id);
    next.splice(targetIndex, 0, sourceId);
    reorderTabs(next);
  }

  function handleContextMenu(event: MouseEvent<HTMLButtonElement>): void {
    event.preventDefault();
    const action = window.prompt(
      "Rename / Close / Close Others / Remove / Force Remove",
      "Rename",
    );
    if (!action) {
      return;
    }
    const normalized = action.trim().toLowerCase();
    if (normalized === "rename") {
      const name = window.prompt("Project name", project.name);
      if (name) {
        renameProject(project.id, name);
      }
      return;
    }
    if (normalized === "close") {
      void closeProjectTab(project.id);
      return;
    }
    if (normalized === "close others") {
      closeOtherTabs(project.id);
      return;
    }
    if (normalized === "remove") {
      void removeProjectFromWorkspace(project.id);
      return;
    }
    if (normalized === "force remove") {
      void removeProjectFromWorkspace(project.id, true);
    }
  }

  return (
    <button
      className="loom-tab"
      data-active={active ? "true" : "false"}
      data-status={status}
      draggable
      title={project.root}
      onClick={() => setActiveTab(project.id)}
      onContextMenu={handleContextMenu}
      onDragOver={(event) => event.preventDefault()}
      onDragStart={handleDragStart}
      onDrop={handleDrop}
    >
      <span className="loom-tab-stripe" />
      <span className="loom-tab-status" />
      <span className="loom-tab-label">{project.name}</span>
      <span
        className="loom-tab-close"
        role="button"
        tabIndex={-1}
        aria-label={`Close ${project.name}`}
        onClick={(event) => {
          event.stopPropagation();
          void closeProjectTab(project.id);
        }}
      >
        x
      </span>
    </button>
  );
}

export function TabBar() {
  const projects = useWorkspaceStore((state) => state.projects);
  const openTabs = useWorkspaceStore((state) => state.openTabs);
  const activeTabId = useWorkspaceStore((state) => state.activeTabId);
  const pickAndAddProject = useWorkspaceStore((state) => state.pickAndAddProject);

  const byId = new Map(projects.map((project) => [project.id, project]));
  const tabs = openTabs.map((id) => byId.get(id)).filter((item): item is Project => Boolean(item));
  const activeProject = activeTabId ? byId.get(activeTabId) : null;

  async function removeActiveProject(force: boolean): Promise<void> {
    if (!activeProject) {
      return;
    }
    const label = force ? "강제로 제거" : "제거";
    const confirmed = window.confirm(
      `${activeProject.name} workspace를 ${label}할까요?\n\nworktree 디렉터리와 local branch가 삭제됩니다.`,
    );
    if (!confirmed) {
      return;
    }
    try {
      await removeProjectFromWorkspace(activeProject.id, force);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <nav className="loom-tabbar" aria-label="Projects">
      <div className="loom-tabs">
        {tabs.map((project) => (
          <ProjectTab key={project.id} project={project} active={project.id === activeTabId} />
        ))}
      </div>
      <button
        className="loom-tab-add"
        type="button"
        aria-label="Add project"
        onClick={() => void pickAndAddProject()}
      >
        +
      </button>
      <button
        className="loom-tab-action"
        type="button"
        disabled={!activeProject}
        onClick={() => void removeActiveProject(false)}
      >
        Remove
      </button>
      <button
        className="loom-tab-action loom-tab-action--danger"
        type="button"
        disabled={!activeProject}
        onClick={() => void removeActiveProject(true)}
      >
        Force Remove
      </button>
    </nav>
  );
}
