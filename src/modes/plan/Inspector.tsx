import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Badge,
  Button,
  Field,
  Input,
  Select,
  Textarea,
} from "@design/components";
import { useGraphStore } from "@stores/index";
import { fallbackProviders, type ProviderConfig, type ProvidersResponse } from "@providers";

function Inspector() {
  const selectedId = useGraphStore((state) => state.selectedNodeId);
  const node = useGraphStore((state) => state.nodes.find((n) => n.id === state.selectedNodeId));
  const updateNode = useGraphStore((state) => state.updateNode);
  const removeNode = useGraphStore((state) => state.removeNode);

  const [providers, setProviders] = useState<ProviderConfig[]>(fallbackProviders);

  useEffect(() => {
    let cancelled = false;
    invoke<ProvidersResponse>("list_providers")
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
  }, []);

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

      <Field label="Workdir (선택)">
        <Input
          value={node.workdir ?? ""}
          placeholder="(워크스페이스 루트)"
          onChange={(event) => updateNode(node.id, { workdir: event.target.value || null })}
        />
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
