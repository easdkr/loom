import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { lastPathSegments, resolveWorkdir, scopeProjectId } from "@core/index";
import { fallbackProviders } from "@providers";
import { Button, Statusbar, StatusbarSpacer } from "@design/components";
import {
  getActiveProject,
  getExecutionStore,
  useGraphStore,
  useSettingsStore,
  useWorkspaceStore,
} from "@stores/index";
import { findPaletteEntry } from "@modes/plan/node-catalog";
import TerminalOutput, { type TerminalOutputHandle, type TerminalSize } from "./TerminalOutput";
import type {
  ProviderConfig,
  ProvidersResponse,
  PtyCompletePayload,
  PtyDataPayload,
  PtyErrorPayload,
  PtyTaskRequest,
} from "@providers";

type RunStatus = "idle" | "running" | "complete" | "error";

function SingleMode() {
  const setMode = useSettingsStore((state) => state.setMode);
  const activeProjectId = useWorkspaceStore((state) => state.activeTabId);
  const activeProject = getActiveProject();
  const upsertNode = useGraphStore((state) => state.upsertNode);
  const selectNode = useGraphStore((state) => state.selectNode);
  const [providers, setProviders] = useState<ProviderConfig[]>(fallbackProviders);
  const [configPath, setConfigPath] = useState("~/.loom/providers.toml");
  const [selectedProvider, setSelectedProvider] = useState("shell");
  const [prompt, setPrompt] = useState("echo hello from loom");
  const [workdir, setWorkdir] = useState("");
  const [stdin, setStdin] = useState("");
  const [status, setStatus] = useState<RunStatus>("idle");
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [message, setMessage] = useState("Ready");
  const activeNodeIdRef = useRef<string | null>(null);
  const activeFullNodeIdRef = useRef<string | null>(null);
  const terminalRef = useRef<TerminalOutputHandle | null>(null);
  const terminalSizeRef = useRef<TerminalSize | null>(null);

  useEffect(() => {
    activeNodeIdRef.current = activeNodeId;
  }, [activeNodeId]);

  useEffect(() => {
    let isMounted = true;

    invoke<ProvidersResponse>("list_providers", {
      request: activeProject?.providersOverride
        ? { override_path: activeProject.providersOverride }
        : null,
    })
      .then((response) => {
        if (!isMounted) {
          return;
        }

        setProviders(response.providers);
        setConfigPath(response.config_path);
        if (!response.providers.some((provider) => provider.name === selectedProvider)) {
          setSelectedProvider(response.providers[0]?.name ?? "shell");
        }
      })
      .catch((error) => {
        if (isMounted) {
          setMessage(`Tauri IPC unavailable: ${String(error)}`);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [activeProject?.providersOverride, selectedProvider]);

  useEffect(() => {
    let unlisteners: UnlistenFn[] = [];
    let cancelled = false;

    Promise.all([
      listen<PtyDataPayload>("pty:data", (event) => {
        if (event.payload.node_id !== activeFullNodeIdRef.current) {
          return;
        }
        terminalRef.current?.write(event.payload.chunk);
      }),
      listen<PtyCompletePayload>("pty:complete", (event) => {
        if (event.payload.node_id !== activeFullNodeIdRef.current) {
          return;
        }
        setStatus(event.payload.timed_out ? "error" : "complete");
        setMessage(
          `${event.payload.completion_reason} - exit ${event.payload.exit_code ?? "n/a"}`,
        );
        activeNodeIdRef.current = null;
        activeFullNodeIdRef.current = null;
        setActiveNodeId(null);
      }),
      listen<PtyErrorPayload>("pty:error", (event) => {
        if (event.payload.node_id !== activeFullNodeIdRef.current) {
          return;
        }
        setStatus("error");
        setMessage(event.payload.error);
        activeNodeIdRef.current = null;
        activeFullNodeIdRef.current = null;
        setActiveNodeId(null);
      }),
    ])
      .then((registered) => {
        if (cancelled) {
          registered.forEach((unlisten) => unlisten());
          return;
        }
        unlisteners = registered;
      })
      .catch((error) => {
        setMessage(`event listener unavailable: ${String(error)}`);
      });

    return () => {
      cancelled = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    setWorkdir("");
  }, [activeProjectId]);

  const provider = useMemo(
    () => providers.find((item) => item.name === selectedProvider) ?? providers[0],
    [providers, selectedProvider],
  );

  const canRun = status !== "running" && prompt.trim().length > 0 && Boolean(provider);

  async function runTask() {
    if (!provider || !canRun) {
      return;
    }
    if (!activeProject) {
      setStatus("error");
      setMessage("프로젝트를 먼저 선택하세요.");
      return;
    }

    const nodeId = `single-${Date.now()}`;
    const fullNodeId = scopeProjectId(activeProject.id, nodeId);
    const request: PtyTaskRequest = {
      node_id: fullNodeId,
      provider: provider.name,
      prompt,
      workdir: resolveWorkdir({ workdir }, activeProject),
      env: {},
      timeout_ms: null,
      cols: terminalSizeRef.current?.cols ?? provider.cols,
      rows: terminalSizeRef.current?.rows ?? provider.rows,
    };

    setActiveNodeId(nodeId);
    activeNodeIdRef.current = nodeId;
    activeFullNodeIdRef.current = fullNodeId;
    getExecutionStore(activeProject.id).getState().beginRun(fullNodeId, [nodeId]);
    getExecutionStore(activeProject.id).getState().setActive([nodeId]);
    terminalRef.current?.reset();
    terminalRef.current?.focus();
    setStatus("running");
    setMessage("Running");

    try {
      await invoke<string>("execute_single", { request });
    } catch (error) {
      setStatus("error");
      setMessage(String(error));
      activeNodeIdRef.current = null;
      activeFullNodeIdRef.current = null;
      setActiveNodeId(null);
    }
  }

  async function killTask() {
    if (!activeNodeId) {
      return;
    }

    try {
      if (!activeFullNodeIdRef.current) {
        return;
      }
      await invoke("node_kill", {
        request: { node_id: activeFullNodeIdRef.current },
      });
      setMessage("Kill requested");
    } catch (error) {
      setStatus("error");
      setMessage(String(error));
    }
  }

  async function writeStdin() {
    if (!activeNodeId || stdin.length === 0) {
      return;
    }

    try {
      if (!activeFullNodeIdRef.current) {
        return;
      }
      await invoke("node_write", {
        request: { node_id: activeFullNodeIdRef.current, input: `${stdin}\n` },
      });
      setStdin("");
    } catch (error) {
      setStatus("error");
      setMessage(String(error));
    }
  }

  async function writeTerminalInput(input: string) {
    if (!activeNodeIdRef.current) {
      return;
    }

    try {
      if (!activeFullNodeIdRef.current) {
        return;
      }
      await invoke("node_write", {
        request: {
          node_id: activeFullNodeIdRef.current,
          input,
        },
      });
    } catch (error) {
      setStatus("error");
      setMessage(String(error));
    }
  }

  function continueInPlan() {
    if (!provider) {
      return;
    }
    const entry = findPaletteEntry("worker:pty");
    const nodeId = `single-${Date.now().toString(36)}`;
    upsertNode({
      id: nodeId,
      type: "worker:pty",
      meta: entry?.meta ?? {
        name: "Single → Plan",
        category: "worker",
        colorToken: "node/worker",
      },
      provider: provider.name,
      prompt,
      workdir: workdir.trim() || null,
      position: { x: 60, y: 60 },
    });
    selectNode(nodeId);
    setMode("plan");
  }

  async function resizeTerminal(size: TerminalSize) {
    terminalSizeRef.current = size;
    if (!activeNodeIdRef.current) {
      return;
    }

    try {
      await invoke("node_resize", {
        request: {
          node_id: activeFullNodeIdRef.current,
          cols: size.cols,
          rows: size.rows,
        },
      });
    } catch (error) {
      if (!String(error).includes("not running")) {
        setMessage(String(error));
      }
    }
  }

  async function browseWorkdir() {
    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath: activeProject?.root,
      title: "Workdir 선택",
    });
    if (typeof selected === "string") {
      setWorkdir(selected);
    }
  }

  return (
    <main className="loom-shell">
      <section className="single-layout">
        <aside className="single-sidebar" aria-label="Single mode controls">
          <label className="field">
            <span>Provider</span>
            <select
              value={provider?.name ?? ""}
              onChange={(event) => setSelectedProvider(event.target.value)}
            >
              {providers.map((item) => (
                <option key={item.name} value={item.name}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>

          <div className="provider-meta">
            <span>{provider?.command}</span>
            <code>{configPath}</code>
          </div>

          <label className="field">
            <span>Workdir</span>
            <div className="inline-input inline-input--workdir">
              <input
                value={workdir}
                readOnly
                title={workdir || activeProject?.root}
                placeholder={activeProject ? activeProject.name : "프로젝트 루트"}
              />
              <button type="button" onClick={browseWorkdir}>
                Browse...
              </button>
              <button type="button" disabled={!workdir} onClick={() => setWorkdir("")}>
                Clear
              </button>
            </div>
          </label>

          <label className="field field-grow">
            <span>Prompt</span>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              spellCheck={false}
            />
          </label>

          <div className="button-row">
            <button className="primary-button" disabled={!canRun} onClick={runTask}>
              Run
            </button>
            <button disabled={status !== "running"} onClick={killTask}>
              Kill
            </button>
          </div>

          {(status === "complete" || status === "error") && prompt.trim() ? (
            <Button variant="ghost" size="sm" onClick={continueInPlan}>
              Continue in Plan →
            </Button>
          ) : null}

          <label className="field">
            <span>Stdin</span>
            <div className="inline-input">
              <input
                value={stdin}
                onChange={(event) => setStdin(event.target.value)}
                disabled={!activeNodeId}
              />
              <button disabled={!activeNodeId || stdin.length === 0} onClick={writeStdin}>
                Send
              </button>
            </div>
          </label>
        </aside>

        <section className="terminal-panel" aria-label="PTY output">
          <div className="terminal-header">
            <span>{activeNodeId ?? "single-ready"}</span>
            <span>{provider?.input_mode}</span>
          </div>
          <TerminalOutput
            ref={terminalRef}
            active={Boolean(activeNodeId)}
            onInput={writeTerminalInput}
            onResize={resizeTerminal}
          />
        </section>
      </section>

      <Statusbar className="mode-statusbar" data-status={status}>
        <span className="loom-status-dot" />
        <span>{message}</span>
        <StatusbarSpacer />
        <span>{activeProject ? lastPathSegments(activeProject.root) : "no project"}</span>
        <span>{provider?.name ?? "—"}</span>
      </Statusbar>
    </main>
  );
}

export default SingleMode;
