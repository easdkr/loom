import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEffect, useMemo, useRef, useState } from "react";
import { fallbackProviders } from "@providers";
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
  const terminalRef = useRef<TerminalOutputHandle | null>(null);
  const terminalSizeRef = useRef<TerminalSize | null>(null);

  useEffect(() => {
    activeNodeIdRef.current = activeNodeId;
  }, [activeNodeId]);

  useEffect(() => {
    let isMounted = true;

    invoke<ProvidersResponse>("list_providers")
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
  }, [selectedProvider]);

  useEffect(() => {
    let unlisteners: UnlistenFn[] = [];
    let cancelled = false;

    Promise.all([
      listen<PtyDataPayload>("pty:data", (event) => {
        if (event.payload.node_id !== activeNodeIdRef.current) {
          return;
        }
        terminalRef.current?.write(event.payload.chunk);
      }),
      listen<PtyCompletePayload>("pty:complete", (event) => {
        if (event.payload.node_id !== activeNodeIdRef.current) {
          return;
        }
        setStatus(event.payload.timed_out ? "error" : "complete");
        setMessage(
          `${event.payload.completion_reason} - exit ${event.payload.exit_code ?? "n/a"}`,
        );
        activeNodeIdRef.current = null;
        setActiveNodeId(null);
      }),
      listen<PtyErrorPayload>("pty:error", (event) => {
        if (event.payload.node_id !== activeNodeIdRef.current) {
          return;
        }
        setStatus("error");
        setMessage(event.payload.error);
        activeNodeIdRef.current = null;
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

  const provider = useMemo(
    () => providers.find((item) => item.name === selectedProvider) ?? providers[0],
    [providers, selectedProvider],
  );

  const canRun = status !== "running" && prompt.trim().length > 0 && Boolean(provider);

  async function runTask() {
    if (!provider || !canRun) {
      return;
    }

    const nodeId = `single-${Date.now()}`;
    const request: PtyTaskRequest = {
      node_id: nodeId,
      provider: provider.name,
      prompt,
      workdir: workdir.trim() || null,
      env: {},
      timeout_ms: null,
      cols: terminalSizeRef.current?.cols ?? provider.cols,
      rows: terminalSizeRef.current?.rows ?? provider.rows,
    };

    setActiveNodeId(nodeId);
    activeNodeIdRef.current = nodeId;
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
      setActiveNodeId(null);
    }
  }

  async function killTask() {
    if (!activeNodeId) {
      return;
    }

    try {
      await invoke("node_kill", { request: { node_id: activeNodeId } });
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
      await invoke("node_write", {
        request: { node_id: activeNodeId, input: `${stdin}\n` },
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
      await invoke("node_write", {
        request: { node_id: activeNodeIdRef.current, input },
      });
    } catch (error) {
      setStatus("error");
      setMessage(String(error));
    }
  }

  async function resizeTerminal(size: TerminalSize) {
    terminalSizeRef.current = size;
    if (!activeNodeIdRef.current) {
      return;
    }

    try {
      await invoke("node_resize", {
        request: {
          node_id: activeNodeIdRef.current,
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

  return (
    <main className="loom-shell">
      <header className="loom-topbar">
        <div className="loom-brand">Loom</div>
        <div className="loom-mode">Single</div>
        <div className="loom-status" data-status={status}>
          <span className="loom-status-dot" />
          {message}
        </div>
      </header>

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
            <input
              value={workdir}
              onChange={(event) => setWorkdir(event.target.value)}
              placeholder={window.location.pathname}
            />
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
    </main>
  );
}

export default SingleMode;
