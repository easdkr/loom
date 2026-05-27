import { useWorkspaceStore } from "@stores/index";
import { Button } from "./Button";

export function EmptyWorkspace() {
  const projects = useWorkspaceStore((state) => state.projects);
  const openTabs = useWorkspaceStore((state) => state.openTabs);
  const pickAndAddProject = useWorkspaceStore((state) => state.pickAndAddProject);
  const cloneRepository = useWorkspaceStore((state) => state.cloneRepository);
  const openWorkspace = useWorkspaceStore((state) => state.openWorkspace);

  const openSet = new Set(openTabs);
  const recent = projects
    .filter((project) => !openSet.has(project.id))
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
    .slice(0, 5);

  return (
    <div className="empty-workspace">
      <div className="empty-workspace-actions">
        <Button
          variant="primary"
          onClick={() => void pickAndAddProject()}
        >
          Create Workspace
        </Button>
        <Button onClick={() => void pickAndAddProject()}>
          Register Repository
        </Button>
        <Button
          onClick={() => {
            const url = window.prompt("Git URL");
            if (url?.trim()) {
              void cloneRepository(url.trim());
            }
          }}
        >
          Clone from Git URL
        </Button>
      </div>
      {recent.length > 0 ? (
        <div className="empty-workspace-recents">
          {recent.map((project) => (
            <button key={project.id} type="button" onClick={() => openWorkspace(project.id)}>
              <span>{project.name}</span>
              <code>{project.root}</code>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
