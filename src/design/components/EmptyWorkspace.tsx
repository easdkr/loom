import { useWorkspaceStore } from "@stores/index";

export function EmptyWorkspace() {
  const projects = useWorkspaceStore((state) => state.projects);
  const openTabs = useWorkspaceStore((state) => state.openTabs);
  const pickAndAddProject = useWorkspaceStore((state) => state.pickAndAddProject);
  const openTab = useWorkspaceStore((state) => state.openTab);

  const openSet = new Set(openTabs);
  const recent = projects
    .filter((project) => !openSet.has(project.id))
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
    .slice(0, 5);

  return (
    <main className="empty-workspace">
      <button
        className="empty-workspace-primary"
        type="button"
        onClick={() => void pickAndAddProject()}
      >
        프로젝트 폴더 선택
      </button>
      {recent.length > 0 ? (
        <div className="empty-workspace-recents">
          {recent.map((project) => (
            <button key={project.id} type="button" onClick={() => openTab(project.id)}>
              <span>{project.name}</span>
              <code>{project.root}</code>
            </button>
          ))}
        </div>
      ) : null}
    </main>
  );
}
