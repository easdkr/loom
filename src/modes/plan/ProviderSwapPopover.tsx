import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IconButton } from "@design/components";
import { useGraphStore } from "@stores/index";
import {
  fallbackProviders,
  type ProviderConfig,
  type ProvidersResponse,
} from "@providers";

interface ProviderSwapPopoverProps {
  open: boolean;
  nodeId: string | null;
  onClose: () => void;
}

function ProviderSwapPopover({ open, nodeId, onClose }: ProviderSwapPopoverProps) {
  const node = useGraphStore((state) => state.nodes.find((n) => n.id === nodeId));
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

  if (!open || !node) {
    return null;
  }

  return (
    <div
      className="plan-review-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Replace Provider"
      onClick={onClose}
    >
      <div
        className="plan-review-sheet plan-review-sheet--popover"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="plan-review-header">
          <span className="plan-review-title">Replace Provider — {node.meta.name}</span>
          <IconButton aria-label="Close" onClick={onClose}>
            ✕
          </IconButton>
        </header>
        <ul className="plan-palette">
          {providers.map((provider) => {
            const active = provider.name === node.provider;
            return (
              <li key={provider.name}>
                <button
                  type="button"
                  className="plan-palette-item ds-button"
                  data-variant={active ? "primary" : "ghost"}
                  onClick={() => {
                    updateNode(node.id, { provider: provider.name });
                    onClose();
                  }}
                >
                  <span className="plan-palette-name">{provider.name}</span>
                  <span className="plan-palette-type">{provider.command}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

export default ProviderSwapPopover;
