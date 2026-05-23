import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Badge,
  Button,
  Field,
  Panel,
  Select,
  Statusbar,
  StatusbarSpacer,
  Textarea,
} from "@design/components";
import { useGraphStore, useSettingsStore } from "@stores/index";
import {
  fallbackProviders,
  type ProviderConfig,
  type ProvidersResponse,
} from "@providers";
import {
  detectComplexity,
  generateAutoPlan,
  type AutoGenerationResult,
  type AutoTemplate,
} from "./auto/generator";
import "./auto/auto.css";

const TEMPLATE_LABELS: Record<AutoTemplate, string> = {
  default: "Design → Implement → Review",
  "review-pipeline": "Implement → Review → Test",
  single: "Single node",
};

function AutoMode() {
  const [origin, setOrigin] = useState("");
  const [template, setTemplate] = useState<AutoTemplate>("default");
  const [autoTemplate, setAutoTemplate] = useState(true);
  const [providers, setProviders] = useState<ProviderConfig[]>(fallbackProviders);
  const [draft, setDraft] = useState<AutoGenerationResult | null>(null);
  const [message, setMessage] = useState("Ready");

  const setNodes = useGraphStore((state) => state.setNodes);
  const setEdges = useGraphStore((state) => state.setEdges);
  const selectNode = useGraphStore((state) => state.selectNode);
  const setMode = useSettingsStore((state) => state.setMode);

  useEffect(() => {
    let cancelled = false;
    invoke<ProvidersResponse>("list_providers")
      .then((response) => {
        if (!cancelled) {
          setProviders(response.providers);
        }
      })
      .catch(() => {
        /* fallback list */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const providerNames = useMemo(() => providers.map((provider) => provider.name), [providers]);

  const effectiveTemplate: AutoTemplate = useMemo(() => {
    if (!autoTemplate) return template;
    return detectComplexity(origin) === "single" ? "single" : "default";
  }, [autoTemplate, template, origin]);

  function handleGenerate() {
    if (!origin.trim()) {
      setMessage("작업 내용을 입력하세요.");
      return;
    }
    const result = generateAutoPlan(origin, effectiveTemplate, providerNames);
    setDraft(result);
    setMessage(`Generated ${result.nodes.length} node(s)`);
  }

  function handleApprove() {
    if (!draft) return;
    setNodes(draft.nodes);
    setEdges(draft.edges);
    selectNode(null);
    setMode("plan");
  }

  function handleDiscard() {
    setDraft(null);
    setMessage("Discarded");
  }

  return (
    <section className="mode-layout mode-layout--auto">
      <Panel className="mode-canvas mode-canvas--full" title="Auto Orchestrator" flush>
        <div className="auto-grid">
          <div className="auto-input">
            <Field label="작업 (자연어)">
              <Textarea
                value={origin}
                rows={8}
                placeholder="예: 결제 시스템을 PG사 2곳을 지원하도록 확장해줘"
                onChange={(event) => setOrigin(event.target.value)}
              />
            </Field>

            <Field label="템플릿">
              <div className="auto-template-row">
                <Select
                  value={template}
                  onChange={(event) => {
                    setTemplate(event.target.value as AutoTemplate);
                    setAutoTemplate(false);
                  }}
                >
                  {(Object.keys(TEMPLATE_LABELS) as AutoTemplate[]).map((key) => (
                    <option key={key} value={key}>
                      {TEMPLATE_LABELS[key]}
                    </option>
                  ))}
                </Select>
                <label className="auto-template-auto">
                  <input
                    type="checkbox"
                    checked={autoTemplate}
                    onChange={(event) => setAutoTemplate(event.target.checked)}
                  />
                  <span>complexity 자동 판단</span>
                </label>
              </div>
            </Field>

            <div className="auto-actions">
              <Button variant="primary" onClick={handleGenerate} disabled={!origin.trim()}>
                Generate
              </Button>
              {draft ? (
                <Button variant="ghost" onClick={handleDiscard}>
                  Clear
                </Button>
              ) : null}
            </div>

            {autoTemplate && origin.trim() ? (
              <div className="auto-detected">
                감지된 complexity: <Badge tone="info">{effectiveTemplate}</Badge>
              </div>
            ) : null}
          </div>

          <div className="auto-preview">
            {draft ? (
              <>
                <p className="auto-reasoning">{draft.reasoning}</p>
                <ol className="auto-node-list">
                  {draft.nodes.map((node) => (
                    <li key={node.id} className="auto-node-list-item">
                      <header>
                        <Badge tone="neutral">{node.type}</Badge>
                        <span className="auto-node-name">{node.meta.name}</span>
                        <Badge tone="info">{node.provider}</Badge>
                      </header>
                      <pre className="auto-node-prompt">{node.prompt}</pre>
                    </li>
                  ))}
                </ol>
                <div className="auto-actions">
                  <Button variant="primary" onClick={handleApprove}>
                    Send to Plan
                  </Button>
                </div>
              </>
            ) : (
              <div className="auto-placeholder">
                Generate를 누르면 오케스트레이터가 그래프를 제안합니다.
              </div>
            )}
          </div>
        </div>
      </Panel>

      <Statusbar className="mode-statusbar">
        <span>Auto</span>
        <StatusbarSpacer />
        <span>{message}</span>
      </Statusbar>
    </section>
  );
}

export default AutoMode;
