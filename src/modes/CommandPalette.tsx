import { useEffect, useMemo, useRef, useState } from "react";
import type { LoomMode } from "@core/index";
import { Badge } from "@design/components";
import { useGraphStore, useWorkspaceStore } from "@stores/index";
import { PALETTE } from "./plan/node-catalog";
import { filterCommandItems, type CommandPaletteItem } from "./commandPaletteModel";

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

const MODE_LABELS: Record<LoomMode, string> = {
  single: "Single",
  plan: "Plan",
  auto: "Auto",
};

let commandNodeCounter = 0;

function commandNodeId(type: string): string {
  commandNodeCounter += 1;
  return `${type.replace(/[^a-z0-9]/gi, "-").toLowerCase()}-${Date.now().toString(36)}-${commandNodeCounter}`;
}

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const projects = useWorkspaceStore((state) => state.projects);
  const repositories = useWorkspaceStore((state) => state.repositories);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const setActiveWorkspace = useWorkspaceStore((state) => state.setActiveWorkspace);
  const openWorkspace = useWorkspaceStore((state) => state.openWorkspace);
  const setWorkspaceMode = useWorkspaceStore((state) => state.setWorkspaceMode);
  const setActiveRepository = useWorkspaceStore((state) => state.setActiveRepository);
  const pickAndAddProject = useWorkspaceStore((state) => state.pickAndAddProject);
  const upsertNode = useGraphStore((state) => state.upsertNode);
  const selectNode = useGraphStore((state) => state.selectNode);
  const activeProject = projects.find((project) => project.id === activeWorkspaceId) ?? null;

  useEffect(() => {
    if (!open) {
      return;
    }
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setQuery("");
    setActiveIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const items = useMemo<CommandPaletteItem[]>(() => {
    const next: CommandPaletteItem[] = [];

    for (const project of projects) {
      next.push({
        id: `workspace:${project.id}`,
        group: "Workspace",
        label: project.name,
        detail: `${project.activeRepository?.name ?? project.activeRepoId} · ${project.displayBranch}`,
        badge: <Badge tone="neutral">{MODE_LABELS[project.mode ?? "plan"]}</Badge>,
        keywords: [project.root],
        run: () => {
          openWorkspace(project.id);
          setActiveWorkspace(project.id);
        },
      });
    }

    if (activeProject) {
      for (const mode of Object.keys(MODE_LABELS) as LoomMode[]) {
        next.push({
          id: `mode:${mode}`,
          group: "Mode",
          label: `Switch to ${MODE_LABELS[mode]}`,
          detail: activeProject.name,
          badge: <Badge tone={activeProject.mode === mode ? "accent" : "neutral"}>{mode}</Badge>,
          run: () => setWorkspaceMode(activeProject.id, mode),
        });
      }

      for (const binding of activeProject.repoBindings) {
        const repository = repositories.find((item) => item.id === binding.repoId);
        next.push({
          id: `repo:${binding.repoId}`,
          group: "Repository",
          label: repository?.name ?? binding.repoId,
          detail: `${binding.branch} · ${binding.worktreePath}`,
          badge: (
            <Badge tone={binding.repoId === activeProject.activeRepoId ? "accent" : "neutral"}>
              {binding.repoId === activeProject.activeRepoId ? "default" : "repo"}
            </Badge>
          ),
          keywords: [binding.worktreePath],
          run: () => setActiveRepository(activeProject.id, binding.repoId),
        });
      }

      for (const entry of PALETTE) {
        next.push({
          id: `node:${entry.type}`,
          group: "Graph",
          label: `Add ${entry.meta.name}`,
          detail: entry.type,
          badge: <Badge tone="info">{entry.defaultProvider}</Badge>,
          run: () => {
            const id = commandNodeId(entry.type);
            upsertNode({
              id,
              type: entry.type,
              meta: { ...entry.meta },
              provider: entry.defaultProvider,
              prompt: entry.defaultPrompt,
              position: { x: 80, y: 80 },
            });
            selectNode(id);
            setWorkspaceMode(activeProject.id, "plan");
          },
        });
      }

      next.push({
        id: "templates:open",
        group: "Graph",
        label: "Open Templates",
        detail: activeProject.name,
        run: () => {
          setWorkspaceMode(activeProject.id, "plan");
          window.setTimeout(() => {
            window.dispatchEvent(new CustomEvent("loom:open-templates"));
          }, 0);
        },
      });
    }

    next.push({
      id: "workspace:create",
      group: "Action",
      label: "Create Workspace",
      detail: "Register local repository",
      run: async () => {
        await pickAndAddProject();
      },
    });

    return next;
  }, [
    activeProject,
    pickAndAddProject,
    openWorkspace,
    projects,
    repositories,
    selectNode,
    setActiveRepository,
    setActiveWorkspace,
    setWorkspaceMode,
    upsertNode,
  ]);

  const filtered = useMemo(() => filterCommandItems(items, query), [items, query]);
  const activeItem = filtered[activeIndex] ?? filtered[0] ?? null;

  useEffect(() => {
    if (activeIndex >= filtered.length) {
      setActiveIndex(Math.max(0, filtered.length - 1));
    }
  }, [activeIndex, filtered.length]);

  if (!open) {
    return null;
  }

  async function runActive(): Promise<void> {
    if (!activeItem) {
      return;
    }
    await activeItem.run();
    onClose();
    previousFocusRef.current?.focus();
  }

  return (
    <div
      className="command-palette-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onKeyDown={(event) => {
        if (event.key !== "Tab") {
          return;
        }
        const focusable = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            "button:not(:disabled), input:not(:disabled)",
          ),
        );
        if (focusable.length === 0) {
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
          previousFocusRef.current?.focus();
        }
      }}
    >
      <div className="command-palette">
        <input
          ref={inputRef}
          className="command-palette-input"
          value={query}
          placeholder="Search commands"
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
              previousFocusRef.current?.focus();
              return;
            }
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActiveIndex((index) => Math.min(filtered.length - 1, index + 1));
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveIndex((index) => Math.max(0, index - 1));
              return;
            }
            if (event.key === "Enter") {
              event.preventDefault();
              void runActive();
            }
          }}
        />
        <div className="command-palette-list" role="listbox" aria-label="Commands">
          {filtered.map((item, index) => {
            const previous = filtered[index - 1];
            const showGroup = !previous || previous.group !== item.group;
            return (
              <div key={item.id} className="command-palette-block">
                {showGroup ? <div className="command-palette-group">{item.group}</div> : null}
                <button
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  className="command-palette-item"
                  data-active={index === activeIndex ? "true" : "false"}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => {
                    void item.run();
                    onClose();
                    previousFocusRef.current?.focus();
                  }}
                >
                  <span className="command-palette-item-copy">
                    <span className="command-palette-label">{item.label}</span>
                    {item.detail ? (
                      <span className="command-palette-detail">{item.detail}</span>
                    ) : null}
                  </span>
                  {item.badge}
                  <span className="command-palette-enter">↵</span>
                </button>
              </div>
            );
          })}
          {filtered.length === 0 ? (
            <div className="command-palette-empty">No commands</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
