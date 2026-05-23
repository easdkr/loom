import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Badge,
  Button,
  Field,
  IconButton,
  Select,
  Textarea,
} from "@design/components";
import { useGraphStore } from "@stores/index";
import {
  fallbackProviders,
  type ProviderConfig,
  type ProvidersResponse,
} from "@providers";

interface PlanReviewProps {
  open: boolean;
  onClose: () => void;
  onApprove: () => void;
}

function PlanReview({ open, onClose, onApprove }: PlanReviewProps) {
  const nodes = useGraphStore((state) => state.nodes);
  const updateNode = useGraphStore((state) => state.updateNode);
  const [providers, setProviders] = useState<ProviderConfig[]>(fallbackProviders);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    invoke<ProvidersResponse>("list_providers")
      .then((response) => {
        if (!cancelled) {
          setProviders(response.providers);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) {
    return null;
  }

  const skippedCount = nodes.filter((node) => node.skipped).length;
  const runnable = nodes.length - skippedCount;

  return (
    <div className="plan-review-backdrop" role="dialog" aria-modal="true" aria-label="Plan Review">
      <div className="plan-review-sheet">
        <header className="plan-review-header">
          <span className="plan-review-title">📋 실행 계획 — 승인 전 수정 가능</span>
          <span className="plan-review-stats">
            {runnable}개 실행 · {skippedCount}개 건너뜀
          </span>
          <IconButton aria-label="Close" onClick={onClose}>
            ✕
          </IconButton>
        </header>

        <ol className="plan-review-list">
          {nodes.map((node, index) => (
            <li
              key={node.id}
              className="plan-review-item"
              data-skipped={node.skipped ? "true" : "false"}
            >
              <header className="plan-review-item-head">
                <span className="plan-review-step">Node-{index + 1}</span>
                <Badge tone="neutral">{node.type}</Badge>
                <span className="plan-review-name">{node.meta.name}</span>
                <span className="plan-review-item-actions">
                  <Button
                    size="sm"
                    variant={node.skipped ? "primary" : "ghost"}
                    onClick={() => updateNode(node.id, { skipped: !node.skipped })}
                  >
                    {node.skipped ? "Skipped" : "Skip"}
                  </Button>
                </span>
              </header>

              <div className="plan-review-item-body">
                <Field label="Provider">
                  <Select
                    inputSize="sm"
                    value={node.provider}
                    onChange={(event) => updateNode(node.id, { provider: event.target.value })}
                    disabled={node.skipped}
                  >
                    {providers.map((provider) => (
                      <option key={provider.name} value={provider.name}>
                        {provider.name}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field label="Prompt">
                  <Textarea
                    value={node.prompt}
                    rows={5}
                    disabled={node.skipped}
                    onChange={(event) => updateNode(node.id, { prompt: event.target.value })}
                  />
                </Field>
              </div>
            </li>
          ))}
        </ol>

        <footer className="plan-review-footer">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onApprove} disabled={runnable === 0}>
            Approve & Run ⌘↵
          </Button>
        </footer>
      </div>
    </div>
  );
}

export default PlanReview;
