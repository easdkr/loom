import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import { Banner } from "../../components/Banner.js";
import { StatusBar, type StatusLevel } from "../../components/StatusBar.js";
import { StreamPanel } from "../../components/StreamPanel.js";
import { PromptForm } from "../../components/PromptForm.js";
import { PtySession, type PtyOutcome } from "../../pty/ptySession.js";
import type { ProviderConfig } from "../../../../src/providers/types.js";

interface RunSingleProps {
  provider: ProviderConfig;
  prompt: string;
  workdir?: string;
  configPath: string;
}

export function RunSingle(props: RunSingleProps) {
  const { exit } = useApp();
  const [buffer, setBuffer] = useState("");
  const [status, setStatus] = useState<StatusLevel>("running");
  const [message, setMessage] = useState("starting…");
  const [outcome, setOutcome] = useState<PtyOutcome | null>(null);
  const [stdinMode, setStdinMode] = useState(false);
  const sessionRef = useRef<PtySession | null>(null);
  const nodeId = useMemo(() => `single-${Date.now().toString(36)}`, []);

  useEffect(() => {
    const session = new PtySession({
      nodeId,
      provider: props.provider,
      prompt: props.prompt,
      workdir: props.workdir,
    });
    sessionRef.current = session;

    session.on("data", (chunk: string) => {
      setBuffer((current) => current + chunk);
    });
    session.on("complete", (result: PtyOutcome) => {
      setOutcome(result);
      const level: StatusLevel = result.errorClass
        ? "error"
        : result.timedOut
          ? "warning"
          : (result.exitCode ?? 0) === 0
            ? "complete"
            : "error";
      setStatus(level);
      const annotations = [
        `${result.completionReason}`,
        `exit ${result.exitCode ?? "n/a"}`,
        result.timedOut ? "timed out" : null,
        result.errorClass ? `error: ${result.errorClass}` : null,
        result.truncated ? "output truncated" : null,
      ].filter(Boolean);
      setMessage(annotations.join(" · "));
      setTimeout(() => exit(), 30);
    });

    session.start().catch((error: unknown) => {
      const text = error instanceof Error ? error.message : String(error);
      setStatus("error");
      setMessage(text);
      setTimeout(() => exit(new Error(text)), 30);
    });

    return () => {
      session.kill();
    };
  }, [exit, nodeId, props.provider, props.prompt, props.workdir]);

  useInput(
    (input, key) => {
      if (stdinMode) {
        return;
      }
      if ((key.ctrl && input === "c") || input === "q") {
        sessionRef.current?.kill();
        setStatus("warning");
        setMessage("kill requested");
        return;
      }
      if (input === "i" && !outcome) {
        setStdinMode(true);
      }
    },
    { isActive: Boolean(process.stdin.isTTY) },
  );

  function submitStdin(value: string): void {
    sessionRef.current?.write(`${value}\n`);
    setStdinMode(false);
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Banner mode={`Single · ${props.provider.name}`} hint={props.configPath} />
      <StreamPanel
        nodeId={nodeId}
        provider={props.provider.name}
        status={
          outcome
            ? (outcome.exitCode ?? 0) === 0 && !outcome.timedOut
              ? "complete"
              : "error"
            : "running"
        }
        buffer={buffer}
        rows={Math.max(8, (process.stdout.rows ?? 24) - 8)}
        cols={Math.max(40, (process.stdout.columns ?? 80) - 4)}
      />
      <Box>
        {status === "running" ? (
          <Text color="yellow">
            <Spinner type="dots" /> {message}
          </Text>
        ) : (
          <StatusBar
            level={status}
            message={message}
            rightHint={outcome ? `result: ${outcome.result.length} chars` : undefined}
          />
        )}
      </Box>
      {stdinMode ? (
        <PromptForm
          label="stdin"
          helper="press enter to send · esc to cancel"
          onSubmit={submitStdin}
          onCancel={() => setStdinMode(false)}
        />
      ) : (
        <Text color="gray">i: send stdin · q / Ctrl-C: kill</Text>
      )}
    </Box>
  );
}
