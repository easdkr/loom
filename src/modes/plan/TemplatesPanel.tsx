import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Field, IconButton, Input } from "@design/components";
import {
  applyTemplate,
  deleteTemplate,
  listTemplates,
  saveCurrentAsTemplate,
  type TemplateMetadata,
} from "./templates";

interface TemplatesPanelProps {
  open: boolean;
  onClose: () => void;
  onApplied: (name: string) => void;
  saveDisabled?: boolean;
}

function TemplatesPanel({ open, onClose, onApplied, saveDisabled }: TemplatesPanelProps) {
  const [items, setItems] = useState<TemplateMetadata[]>([]);
  const [directory, setDirectory] = useState("~/.loom/templates");
  const [saveName, setSaveName] = useState("");
  const [saveLabel, setSaveLabel] = useState("");
  const [saveDescription, setSaveDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const response = await listTemplates();
      setItems(response.templates);
      setDirectory(response.directory);
      setError(null);
    } catch (cause) {
      setError(String(cause));
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  if (!open) {
    return null;
  }

  async function handleApply(item: TemplateMetadata) {
    setBusy(true);
    try {
      await applyTemplate(item.name);
      onApplied(item.name);
      onClose();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(item: TemplateMetadata) {
    setBusy(true);
    try {
      await deleteTemplate(item.name);
      await refresh();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function handleSave() {
    if (!saveName.trim()) {
      setError("템플릿 이름이 필요합니다.");
      return;
    }
    setBusy(true);
    try {
      await saveCurrentAsTemplate(
        saveName.trim(),
        saveLabel.trim() || saveName.trim(),
        saveDescription.trim(),
      );
      setSaveName("");
      setSaveLabel("");
      setSaveDescription("");
      await refresh();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="plan-review-backdrop" role="dialog" aria-modal="true" aria-label="Templates">
      <div className="plan-review-sheet">
        <header className="plan-review-header">
          <span className="plan-review-title">그래프 템플릿</span>
          <span className="plan-review-stats">{items.length}개</span>
          <IconButton aria-label="Close" onClick={onClose}>
            ✕
          </IconButton>
        </header>

        <ol className="plan-review-list">
          {items.map((item) => (
            <li key={item.name} className="plan-review-item">
              <header className="plan-review-item-head">
                <Badge tone={item.builtin ? "info" : "neutral"}>
                  {item.builtin ? "builtin" : "user"}
                </Badge>
                <span className="plan-review-name">{item.display_name}</span>
                <span className="plan-review-stats">{item.node_count} nodes</span>
              </header>
              <p className="plan-inspector-empty">{item.description || item.name}</p>
              <div className="plan-inspector-actions">
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy}
                  onClick={() => handleApply(item)}
                >
                  Apply
                </Button>
                {!item.builtin ? (
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={busy}
                    onClick={() => handleDelete(item)}
                  >
                    Delete
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ol>

        <div className="plan-review-list">
          <Field label="현재 그래프를 템플릿으로 저장">
            <Input
              value={saveName}
              placeholder="slug (a-z0-9-_)"
              onChange={(event) => setSaveName(event.target.value)}
            />
          </Field>
          <Field label="표시 이름">
            <Input
              value={saveLabel}
              placeholder="Display name"
              onChange={(event) => setSaveLabel(event.target.value)}
            />
          </Field>
          <Field label="설명">
            <Input
              value={saveDescription}
              placeholder="짧은 설명"
              onChange={(event) => setSaveDescription(event.target.value)}
            />
          </Field>
        </div>

        {error ? (
          <p className="plan-inspector-empty" data-tone="danger">
            {error}
          </p>
        ) : null}

        <footer className="plan-review-footer">
          <span className="plan-drawer-meta">{directory}</span>
          <Button
            variant="primary"
            disabled={busy || saveDisabled || !saveName.trim()}
            onClick={handleSave}
          >
            Save Template
          </Button>
        </footer>
      </div>
    </div>
  );
}

export default TemplatesPanel;
