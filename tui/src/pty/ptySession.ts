import { spawn, type IPty } from "node-pty";
import { EventEmitter } from "node:events";
import type { ProviderConfig } from "../../../src/providers/types.js";
import { cleanForDisplay, stripAnsi } from "./ansi.js";
import { materializePrompt, type MaterializedPrompt } from "./promptHandoff.js";
import { promptForProvider } from "./providerPrompt.js";
import { validateProviderForExecution } from "./providerLoader.js";
import { compileRegex } from "./regex.js";

export type CompletionReason =
  | "completion-pattern"
  | "process-exit"
  | "timeout-fallback"
  | "idle-timeout-fallback"
  | "killed";

export interface PtyOutcome {
  nodeId: string;
  result: string;
  completionReason: CompletionReason;
  exitCode: number | null;
  timedOut: boolean;
}

export interface PtySessionOptions {
  nodeId: string;
  provider: ProviderConfig;
  prompt: string;
  workdir?: string;
  env?: Record<string, string>;
  timeoutMs?: number | null;
  cols?: number;
  rows?: number;
}

const POLL_INTERVAL_MS = 50;
const EXIT_GRACE_MS = 1500;

interface PendingFinish {
  reason: CompletionReason;
  timedOut: boolean;
  graceTimer: NodeJS.Timeout | null;
}

export class PtySession extends EventEmitter {
  readonly nodeId: string;
  readonly provider: ProviderConfig;
  private readonly workdir?: string;
  private readonly extraEnv: Record<string, string>;
  private readonly cols: number;
  private readonly rows: number;
  private readonly completionTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly completionPattern: RegExp | null;
  private readonly rawPrompt: string;
  private pty: IPty | null = null;
  private rawOutput = "";
  private lastOutputAt = 0;
  private completed = false;
  private pending: PendingFinish | null = null;
  private killed = false;
  private timeoutTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private materializedPrompt: MaterializedPrompt | null = null;

  constructor(options: PtySessionOptions) {
    super();
    this.nodeId = options.nodeId;
    this.provider = options.provider;
    this.rawPrompt = options.prompt;
    this.workdir = options.workdir;
    this.extraEnv = options.env ?? {};
    this.cols = options.cols ?? options.provider.cols ?? 220;
    this.rows = options.rows ?? options.provider.rows ?? 50;
    this.completionTimeoutMs =
      options.timeoutMs ?? options.provider.completion_timeout_ms;
    this.idleTimeoutMs = options.provider.idle_timeout_ms;
    this.completionPattern = compileRegex(options.provider.completion_pattern);
  }

  async start(): Promise<void> {
    validateProviderForExecution(this.provider);

    this.materializedPrompt = await materializePrompt({
      rawPrompt: this.rawPrompt,
      workdir: this.workdir,
      nodeId: this.nodeId,
    });

    const promptForCli = promptForProvider(
      this.provider,
      this.materializedPrompt.prompt,
    );

    const args = [...this.provider.args];
    if (this.provider.input_mode === "append-arg") {
      args.push(promptForCli);
    }

    const env = {
      ...process.env,
      ...this.provider.env,
      ...this.extraEnv,
      COLUMNS: String(this.cols),
      LINES: String(this.rows),
    } as Record<string, string>;

    this.pty = spawn(this.provider.command, args, {
      name: "xterm-256color",
      cols: this.cols,
      rows: this.rows,
      cwd: this.workdir ?? process.cwd(),
      env,
      handleFlowControl: false,
    });

    this.lastOutputAt = Date.now();

    this.pty.onData((chunk) => this.handleData(chunk));
    this.pty.onExit(({ exitCode, signal }) => this.handleExit(exitCode, signal));

    if (this.provider.input_mode === "stdin") {
      this.pty.write(`${promptForCli}\n`);
    }

    this.timeoutTimer = setTimeout(() => {
      this.requestFinish("timeout-fallback", true);
    }, this.completionTimeoutMs);

    this.scheduleIdleCheck();
  }

  write(input: string): void {
    if (!this.pty || this.completed) {
      return;
    }
    this.pty.write(input);
  }

  resize(cols: number, rows: number): void {
    if (!this.pty || this.completed) {
      return;
    }
    this.pty.resize(Math.max(1, cols), Math.max(1, rows));
  }

  kill(): void {
    if (!this.pty || this.completed) {
      return;
    }
    this.killed = true;
    this.requestFinish("killed", true);
  }

  private handleData(chunk: string): void {
    if (this.completed) {
      return;
    }
    this.rawOutput += chunk;
    this.lastOutputAt = Date.now();
    this.emit("data", chunk);
    if (
      !this.pending &&
      this.completionPattern &&
      this.completionPattern.test(stripAnsi(this.rawOutput))
    ) {
      this.requestFinish("completion-pattern", false);
    }
  }

  private handleExit(exitCode: number, signal?: number): void {
    if (this.completed) {
      return;
    }
    if (this.pending) {
      this.finalize(this.pending.reason, exitCode ?? signal ?? null, this.pending.timedOut);
      return;
    }
    const reason: CompletionReason = this.killed ? "killed" : "process-exit";
    this.finalize(reason, exitCode ?? signal ?? null, this.killed);
  }

  private requestFinish(reason: CompletionReason, timedOut: boolean): void {
    if (this.completed || this.pending) {
      return;
    }
    this.pending = {
      reason,
      timedOut,
      graceTimer: setTimeout(() => {
        if (!this.completed) {
          this.finalize(reason, null, timedOut);
        }
      }, EXIT_GRACE_MS),
    };
    try {
      this.pty?.kill();
    } catch {
      // best effort — handleExit will still fire eventually
    }
  }

  private scheduleIdleCheck(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(
      () => {
        if (this.completed) {
          return;
        }
        const elapsedIdle = Date.now() - this.lastOutputAt;
        if (this.rawOutput.length > 0 && elapsedIdle >= this.idleTimeoutMs) {
          this.requestFinish("idle-timeout-fallback", true);
          return;
        }
        this.scheduleIdleCheck();
      },
      Math.min(POLL_INTERVAL_MS * 20, Math.max(POLL_INTERVAL_MS, this.idleTimeoutMs)),
    );
  }

  private finalize(
    reason: CompletionReason,
    exitCode: number | null,
    timedOut: boolean,
  ): void {
    if (this.completed) {
      return;
    }
    this.completed = true;

    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.pending?.graceTimer) {
      clearTimeout(this.pending.graceTimer);
    }
    this.pending = null;

    const cleanedResult = cleanForDisplay(this.rawOutput).trim();
    const outcome: PtyOutcome = {
      nodeId: this.nodeId,
      result: cleanedResult,
      completionReason: reason,
      exitCode,
      timedOut,
    };

    void this.materializedPrompt?.cleanup();
    this.emit("complete", outcome);
  }
}

export function isSuccessfulOutcome(outcome: PtyOutcome): boolean {
  return !outcome.timedOut && (outcome.exitCode === null || outcome.exitCode === 0);
}
