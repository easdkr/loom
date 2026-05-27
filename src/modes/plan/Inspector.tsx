import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Badge,
  Button,
  Field,
  Input,
  Select,
  Textarea,
} from "@design/components";
import { useGraphStore } from "@stores/index";
import { useWorkspaceStore } from "@stores/index";
import { fallbackProviders, type ProviderConfig, type ProvidersResponse } from "@providers";

function Inspector() {
  const selectedId = useGraphStore((state) => state.selectedNodeId);
  const node = useGraphStore((state) => state.nodes.find((n) => n.id === state.selectedNodeId));
  const updateNode = useGraphStore((state) => state.updateNode);
  const removeNode = useGraphStore((state) => state.removeNode);
  const activeProjectId = useWorkspaceStore((state) => state.activeTabId);
  const activeProject = useWorkspaceStore((state) =>
    state.projects.find((project) => project.id === activeProjectId),
  );
  const repositories = useWorkspaceStore((state) => state.repositories);

  const [providers, setProviders] = useState<ProviderConfig[]>(fallbackProviders);

  useEffect(() => {
    let cancelled = false;
    invoke<ProvidersResponse>("list_providers", {
      request: activeProject?.providersOverride
        ? { override_path: activeProject.providersOverride }
        : null,
    })
      .then((response) => {
        if (!cancelled) {
          setProviders(response.providers);
        }
      })
      .catch(() => {
        /* keep fallback list */
      });
    return () => {
      cancelled = true;
    };
  }, [activeProject?.providersOverride]);

  async function browseWorkdir() {
    if (!node) {
      return;
    }
    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath: activeProject?.root,
      title: "Workdir 선택",
    });
    if (typeof selected === "string") {
      updateNode(node.id, { workdir: selected });
    }
  }

  if (!selectedId || !node) {
    return (
      <div className="plan-inspector-empty">
        노드를 선택하면 프롬프트·Provider·스킵 토글을 편집할 수 있습니다.
      </div>
    );
  }

  return (
    <div className="plan-inspector">
      <div className="plan-inspector-head">
        <Badge tone="neutral">{node.type}</Badge>
        <span className="plan-inspector-name">{node.meta.name}</span>
      </div>

      <Field label="Provider">
        <Select
          value={node.provider}
          onChange={(event) => updateNode(node.id, { provider: event.target.value })}
        >
          {providers.map((provider) => (
            <option key={provider.name} value={provider.name}>
              {provider.name}
            </option>
          ))}
        </Select>
      </Field>

      {activeProject && activeProject.repoBindings.length > 1 ? (
        <Field label="Repository">
          <Select
            value={node.repoId ?? activeProject.activeRepoId}
            onChange={(event) => updateNode(node.id, { repoId: event.target.value })}
          >
            {activeProject.repoBindings.map((binding) => {
              const repository = repositories.find((item) => item.id === binding.repoId);
              return (
                <option key={binding.repoId} value={binding.repoId}>
                  {repository?.name ?? binding.repoId}
                </option>
              );
            })}
          </Select>
        </Field>
      ) : null}

      <Field label="Worktree">
        <Select
          value={node.worktreePolicy ?? "workspace"}
          onChange={(event) =>
            updateNode(node.id, {
              worktreePolicy:
                event.target.value === "node-isolated" ? "node-isolated" : "workspace",
            })
          }
        >
          <option value="workspace">Workspace</option>
          <option value="node-isolated">Node isolated</option>
        </Select>
      </Field>

      <Field label="Workdir (선택)">
        <div className="inline-input inline-input--workdir">
          <Input
            value={node.workdir ?? ""}
            readOnly
            title={node.workdir || activeProject?.root}
            placeholder={activeProject ? activeProject.name : "프로젝트 루트"}
          />
          <Button size="sm" variant="ghost" onClick={browseWorkdir}>
            Browse...
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!node.workdir}
            onClick={() => updateNode(node.id, { workdir: null })}
          >
            Clear
          </Button>
        </div>
      </Field>

      <Field label="Prompt">
        <Textarea
          value={node.prompt}
          rows={8}
          onChange={(event) => updateNode(node.id, { prompt: event.target.value })}
        />
      </Field>

      <div className="plan-inspector-actions">
        <Button
          variant={node.skipped ? "primary" : "default"}
          onClick={() => updateNode(node.id, { skipped: !node.skipped })}
        >
          {node.skipped ? "Skipped" : "Skip"}
        </Button>
        <Button variant="danger" onClick={() => removeNode(node.id)}>
          Delete
        </Button>
      </div>
    </div>
  );
}

export default Inspector;
