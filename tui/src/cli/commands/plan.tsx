import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import { Banner } from "../../components/Banner.js";
import { PlanReview } from "../../components/PlanReview.js";
import { StreamPanel } from "../../components/StreamPanel.js";
import { StatusBar, type StatusLevel } from "../../components/StatusBar.js";
import { PlanExecutor } from "../../graph/planExecutor.js";
import { toExecutionPlan, type PlanDraft } from "../../plan/planSchema.js";
import type { ProjectContext } from "../index.js";
import type { ProviderConfig } from "../../../../src/providers/types.js";
import type { PtyOutcome } from "../../pty/ptySession.js";

type Phase = "review" | "running" | "done" | "cancelled";

interface NodeView {
  id: string;
  provider: string;
  status: "pending" | "running" | "complete" | "error" | "skipped";
  buffer: string;
  outcome: PtyOutcome | null;
  error?: string;
}

interface PlanModeProps {
  initialDraft: PlanDraft;
  providers: ProviderConfig[];
  configPath: string;
  project: ProjectContext;
  autoApprove?: boolean;
  runIdPrefix?: string;
}

export function PlanMode(props: PlanModeProps) {
  const { exit } = useApp();
  const [draft, setDraft] = useState<PlanDraft>(props.initialDraft);
  const [phase, setPhase] = useState<Phase>(props.autoApprove ? "running" : "review");
  const [nodeViews, setNodeViews] = useState<Record<string, NodeView>>({});
  const [statusMessage, setStatusMessage] = useState(
    props.autoApprove ? "preparing execution…" : "review and approve",
  );
  const [statusLevel, setStatusLevel] = useState<StatusLevel>(
    props.autoApprove ? "running" : "idle",
  );
  const executorRef = useRef<PlanExecutor | null>(null);
  const runId = useMemo(
    () => `${props.runIdPrefix ?? "plan"}-${Date.now().toString(36)}`,
    [props.runIdPrefix],
  );

  function ensureNodeView(id: string, provider: string, status: NodeView["status"]): void {
    setNodeViews((current) => {
      if (current[id]) {
        return current;
      }
      return {
        ...current,
        [id]: {
          id,
          provider,
          status,
          buffer: "",
          outcome: null,
        },
      };
    });
  }

  function startExecution(): void {
    const providersMap = new Map(props.providers.map((provider) => [provider.name, provider]));
    const { plan, skip } = toExecutionPlan(draft);

    const initial: Record<string, NodeView> = {};
    for (const node of draft.nodes) {
      initial[node.id] = {
        id: node.id,
        provider: node.provider,
        status: skip.has(node.id) ? "skipped" : "pending",
        buffer: "",
        outcome: null,
      };
    }
    setNodeViews(initial);

    const executor = new PlanExecutor({
      runId,
      plan,
      providers: providersMap,
      skip,
      concurrencyLimit: 2,
      projectRoot: props.project.root,
    });
    executorRef.current = executor;

    executor.on("node-start", ({ nodeId }: { nodeId: string }) => {
      setNodeViews((current) => ({
        ...current,
        [nodeId]: {
          ...(current[nodeId] ?? {
            id: nodeId,
            provider: "unknown",
            buffer: "",
            outcome: null,
            status: "pending",
          }),
          status: "running",
        },
      }));
      setStatusMessage(`running ${nodeId}`);
      setStatusLevel("running");
    });

    executor.on("data", ({ nodeId, chunk }: { nodeId: string; chunk: string }) => {
      setNodeViews((current) => {
        const view = current[nodeId];
        if (!view) {
          return current;
        }
        return {
          ...current,
          [nodeId]: { ...view, buffer: view.buffer + chunk },
        };
      });
    });

    executor.on("node-complete", ({ outcome }: { outcome: PtyOutcome }) => {
      const ok = !outcome.timedOut && (outcome.exitCode ?? 0) === 0;
      setNodeViews((current) => {
        const view = current[outcome.nodeId];
        if (!view) {
          return current;
        }
        return {
          ...current,
          [outcome.nodeId]: {
            ...view,
            status: ok ? "complete" : "error",
            outcome,
          },
        };
      });
    });

    executor.on("node-skip", ({ nodeId }: { nodeId: string }) => {
      setNodeViews((current) => {
        const view = current[nodeId];
        if (!view) {
          return current;
        }
        return { ...current, [nodeId]: { ...view, status: "skipped" } };
      });
    });

    executor.on(
      "node-error",
      ({ nodeId, error }: { nodeId: string; error: string }) => {
        ensureNodeView(nodeId, "unknown", "error");
        setNodeViews((current) => {
          const view = current[nodeId];
          if (!view) {
            return current;
          }
          return { ...current, [nodeId]: { ...view, status: "error", error } };
        });
      },
    );

    executor
      .run()
      .then((result) => {
        const ok = result.failed.length === 0;
        setStatusLevel(ok ? "complete" : "error");
        setStatusMessage(
          ok
            ? `done · ${result.completed.length} ok · ${result.skipped.length} skipped`
            : `failed · ${result.failed.join(", ")}`,
        );
        setPhase("done");
        setTimeout(() => exit(ok ? undefined : new Error(`plan failed: ${result.failed.join(", ")}`)), 30);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        setStatusLevel("error");
        setStatusMessage(`plan error: ${message}`);
        setPhase("done");
        setTimeout(() => exit(new Error(message)), 30);
      });
  }

  useEffect(() => {
    if (phase === "running") {
      startExecution();
    }
    return () => {
      executorRef.current?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  useInput(
    (input, key) => {
      if (phase === "running") {
        if ((key.ctrl && input === "c") || input === "q") {
          executorRef.current?.cancel();
          setStatusLevel("warning");
          setStatusMessage("execution cancelled");
          setPhase("cancelled");
          setTimeout(() => exit(), 30);
        }
      }
      if (phase === "done") {
        if (key.return || input === "q") {
          exit();
        }
      }
    },
    { isActive: Boolean(process.stdin.isTTY) },
  );

  function handleApprove(): void {
    setPhase("running");
    setStatusLevel("running");
    setStatusMessage("preparing execution…");
  }

  function handleCancel(): void {
    setStatusLevel("warning");
    setStatusMessage("cancelled");
    setPhase("cancelled");
    setTimeout(() => exit(), 30);
  }

  const rows = process.stdout.rows ?? 24;
  const cols = process.stdout.columns ?? 80;
  const perPanelRows = Math.max(4, Math.floor((rows - 10) / Math.max(1, draft.nodes.length)));

  return (
    <Box flexDirection="column" paddingX={1}>
      <Banner
        mode={`Plan · ${runId}`}
        hint={`${props.project.name} · ${props.project.root} · ${draft.nodes.length} nodes · ${props.configPath}`}
      />
      {phase === "review" ? (
        <PlanReview
          draft={draft}
          providers={props.providers}
          onChange={setDraft}
          onApprove={handleApprove}
          onCancel={handleCancel}
        />
      ) : (
        <Box flexDirection="column">
          {draft.nodes.map((node) => {
            const view = nodeViews[node.id];
            return (
              <StreamPanel
                key={node.id}
                nodeId={node.id}
                provider={node.provider}
                status={view?.status ?? "pending"}
                buffer={view?.buffer ?? ""}
                rows={perPanelRows}
                cols={Math.max(40, cols - 4)}
              />
            );
          })}
          {phase === "running" ? (
            <Text color="yellow">
              <Spinner type="dots" /> {statusMessage}
            </Text>
          ) : (
            <StatusBar
              level={statusLevel}
              message={statusMessage}
              rightHint={phase === "done" ? "press q or enter to exit" : undefined}
            />
          )}
        </Box>
      )}
    </Box>
  );
}
