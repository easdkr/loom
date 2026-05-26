import { useMemo, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { Badge, Button, type BadgeTone } from "@design/components";
import type {
  ExecutionTranscriptMessage,
  ExecutionTranscriptStatus,
} from "@stores/executionTranscript";
import { sanitizeTranscriptText } from "@stores/executionTranscript";

type AgentRunStatus = ExecutionTranscriptStatus | "idle" | "queued" | "skipped";
type AgentRunTab = "conversation" | "raw";

interface AgentRunViewProps {
  nodeId: string;
  provider: string;
  status: AgentRunStatus;
  messages: ExecutionTranscriptMessage[];
  rawOutput: string;
  activity?: string;
  running: boolean;
  title?: string;
  subtitle?: string;
  meta?: ReactNode;
  footerMeta?: ReactNode;
  composerPlaceholder?: string;
  idleSubmitLabel?: string;
  allowIdleSubmit?: boolean;
  className?: string;
  onSubmitInput?: (input: string) => void | Promise<void>;
  onSubmitControl?: (input: string) => void | Promise<void>;
  onCancel?: () => void | Promise<void>;
  cancelDisabled?: boolean;
}

const STATUS_TONE: Record<AgentRunStatus, BadgeTone> = {
  idle: "neutral",
  queued: "info",
  running: "accent",
  complete: "success",
  error: "danger",
  skipped: "neutral",
};

function statusLabel(status: AgentRunStatus): string {
  if (status === "complete") {
    return "done";
  }
  return status;
}

function hasVisibleMessage(messages: ExecutionTranscriptMessage[]): boolean {
  return messages.some((message) => message.content.trim().length > 0);
}

function renderMessageLabel(message: ExecutionTranscriptMessage): string {
  if (message.role === "assistant") {
    return "Assistant";
  }
  if (message.role === "system") {
    return "System";
  }
  return "User";
}

function AgentRunView({
  nodeId,
  provider,
  status,
  messages,
  rawOutput,
  activity,
  running,
  title,
  subtitle,
  meta,
  footerMeta,
  composerPlaceholder,
  idleSubmitLabel = "Start",
  allowIdleSubmit = false,
  className,
  onSubmitInput,
  onSubmitControl,
  onCancel,
  cancelDisabled,
}: AgentRunViewProps) {
  const [activeTab, setActiveTab] = useState<AgentRunTab>("conversation");
  const [input, setInput] = useState("");
  const canSubmit =
    Boolean(onSubmitInput) && input.trim().length > 0 && (running || allowIdleSubmit);
  const canSubmitControl = running && Boolean(onSubmitControl);
  const rawLineCount = useMemo(
    () => (rawOutput.length === 0 ? 0 : rawOutput.split(/\r?\n/).length),
    [rawOutput],
  );
  const displayRawOutput = useMemo(() => sanitizeTranscriptText(rawOutput), [rawOutput]);

  async function submitComposerText() {
    if (!running && !allowIdleSubmit) {
      return;
    }
    const value = input;
    setInput("");
    if (!running && value.trim().length === 0) {
      return;
    }
    if (value.trim().length > 0 && onSubmitInput) {
      await onSubmitInput(value);
      return;
    }
    if (onSubmitControl) {
      await onSubmitControl("\r");
    }
  }

  async function submitControl(input: string) {
    if (canSubmitControl && onSubmitControl) {
      await onSubmitControl(input);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submitComposerText();
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!running && !allowIdleSubmit) {
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submitComposerText();
      return;
    }
    if (input.length > 0) {
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      void submitControl("\u001b[A");
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      void submitControl("\u001b[B");
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      void submitControl("\u001b");
    }
  }

  return (
    <section className={["agent-run-view", className].filter(Boolean).join(" ")}>
      <header className="agent-run-header">
        <div className="agent-run-heading">
          <span className="agent-run-title">{title ?? nodeId}</span>
          <span className="agent-run-subtitle">{subtitle ?? provider}</span>
        </div>
        <div className="agent-run-header-actions">
          {meta}
          <Badge tone={STATUS_TONE[status]}>{statusLabel(status)}</Badge>
          {onCancel && running ? (
            <Button
              size="sm"
              variant="danger"
              onClick={onCancel}
              disabled={cancelDisabled ?? !running}
            >
              Kill
            </Button>
          ) : null}
        </div>
      </header>

      <div className="agent-run-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "conversation"}
          data-active={activeTab === "conversation"}
          className="agent-run-tab"
          onClick={() => setActiveTab("conversation")}
        >
          Conversation
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "raw"}
          data-active={activeTab === "raw"}
          className="agent-run-tab"
          onClick={() => setActiveTab("raw")}
        >
          Raw
        </button>
      </div>

      <div className="agent-run-body">
        {activeTab === "raw" ? (
          <pre className="agent-run-raw" aria-label={`${nodeId} raw PTY output`}>
            {displayRawOutput || "(no raw output)"}
          </pre>
        ) : (
          <div className="agent-run-messages" aria-label={`${nodeId} conversation`}>
            {hasVisibleMessage(messages) ? (
              messages.map((message) => (
                <article
                  key={message.id}
                  className="agent-run-message"
                  data-role={message.role}
                  data-status={message.status}
                >
                  <div className="agent-run-message-meta">
                    <span>{renderMessageLabel(message)}</span>
                    <span>{message.status}</span>
                  </div>
                  <p>{message.content || " "}</p>
                </article>
              ))
            ) : (
              <div className="agent-run-empty">No conversation yet.</div>
            )}
            {running && activity ? (
              <div className="agent-run-activity" aria-live="polite">
                {activity}
              </div>
            ) : null}
          </div>
        )}
      </div>

      <footer className="agent-run-footer">
        <span className="agent-run-footnote">
          {footerMeta ?? (
            <>
              node {nodeId} · {provider} · raw lines {rawLineCount}
            </>
          )}
        </span>
        <form className="agent-run-composer" onSubmit={handleSubmit}>
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleComposerKeyDown}
            disabled={(!running && !allowIdleSubmit) || (!onSubmitInput && !onSubmitControl)}
            spellCheck={false}
            aria-label="Message"
            placeholder={composerPlaceholder}
          />
          <Button size="sm" variant="primary" type="submit" disabled={!canSubmit}>
            {running ? "Send" : idleSubmitLabel}
          </Button>
        </form>
      </footer>
    </section>
  );
}

export default AgentRunView;
