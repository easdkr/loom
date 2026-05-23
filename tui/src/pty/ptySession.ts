import { spawn, type IPty } from "node-pty";
import { EventEmitter } from "node:events";
import type { ProviderConfig } from "../../../src/providers/types.js";
import { cleanForDisplay } from "./ansi.js";
import {
  BoundedBuffer,
  CompletionDetector,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_SETTLE_MS,
  type Detection,
} from "./completion.js";
import { materializePrompt, type MaterializedPrompt } from "./promptHandoff.js";
import { promptForProvider } from "./providerPrompt.js";
import { validateProviderForExecution } from "./providerLoader.js";
import { compileRegex } from "./regex.js";

export type CompletionReason =
  | "completion-pattern"
  | "process-exit"
  | "timeout-fallback"
  | "idle-timeout-fallback"
  | "provider-error"
  | "killed";

export type ErrorClass = "rate-limit" | "provider-error" | null;

export interface PtyOutcome {
  nodeId: string;
  result: string;
  completionReason: CompletionReason;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  errorClass: ErrorClass;
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
  errorClass: ErrorClass;
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
  private readonly settleMs: number;
  private readonly detector: CompletionDetector;
  private readonly buffer: BoundedBuffer;
  private readonly rawPrompt: string;
  private pty: IPty | null = null;
  private lastOutputAt = 0;
  private lastDetection: Detection | null = null;
  private completed = false;
  private pending: PendingFinish | null = null;
  private killed = false;
  private timeoutTimer: NodeJS.Timeout | null = null;
  private settleTimer: NodeJS.Timeout | null = null;
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
    this.settleMs = options.provider.settle_ms ?? DEFAULT_SETTLE_MS;
    this.detector = new CompletionDetector({
      completionPattern: compileRegex(options.provider.completion_pattern),
      errorPattern: compileRegex(options.provider.error_pattern ?? ""),
      settleMs: this.settleMs,
    });
    this.buffer = new BoundedBuffer(
      options.provider.max_output_bytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    );
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
      this.requestFinish("timeout-fallback", true, null);
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
    this.requestFinish("killed", true, null);
  }

  private handleData(chunk: string): void {
    if (this.completed) {
      return;
    }
    this.buffer.append(chunk);
    this.lastOutputAt = Date.now();
    this.emit("data", chunk);

    if (this.pending) {
      return;
    }

    const detection = this.detector.push(chunk);
    this.lastDetection = detection;

    if (detection?.kind === "error") {
      this.requestFinish("provider-error", false, classifyError(this.provider, chunk));
      return;
    }

    if (detection?.kind === "completion") {
      this.scheduleSettleCheck();
    }
  }

  private handleExit(exitCode: number, signal?: number): void {
    if (this.completed) {
      return;
    }
    if (this.pending) {
      this.finalize(
        this.pending.reason,
        exitCode ?? signal ?? null,
        this.pending.timedOut,
        this.pending.errorClass,
      );
      return;
    }
    let reason: CompletionReason;
    if (this.killed) {
      reason = "killed";
    } else if (this.lastDetection?.kind === "completion") {
      // Pattern matched before the process exited cleanly — preserve that
      // semantic rather than reporting a bare "process-exit".
      reason = "completion-pattern";
    } else {
      reason = "process-exit";
    }
    this.finalize(reason, exitCode ?? signal ?? null, this.killed, null);
  }

  private scheduleSettleCheck(): void {
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
    }
    this.settleTimer = setTimeout(() => {
      if (this.completed || this.pending) {
        return;
      }
      if (this.detector.isSettled(this.lastOutputAt)) {
        this.requestFinish("completion-pattern", false, null);
      } else if (this.lastDetection?.kind === "completion") {
        // Pattern still considered matched but settle not reached — re-arm.
        this.scheduleSettleCheck();
      }
    }, Math.max(POLL_INTERVAL_MS, this.settleMs));
  }

  private requestFinish(
    reason: CompletionReason,
    timedOut: boolean,
    errorClass: ErrorClass,
  ): void {
    if (this.completed || this.pending) {
      return;
    }
    this.pending = {
      reason,
      timedOut,
      errorClass,
      graceTimer: setTimeout(() => {
        if (!this.completed) {
          this.finalize(reason, null, timedOut, errorClass);
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
        if (this.buffer.byteLength > 0 && elapsedIdle >= this.idleTimeoutMs) {
          this.requestFinish("idle-timeout-fallback", true, null);
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
    errorClass: ErrorClass,
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
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    if (this.pending?.graceTimer) {
      clearTimeout(this.pending.graceTimer);
    }
    this.pending = null;

    const cleanedResult = cleanForDisplay(this.buffer.toString()).trim();
    const outcome: PtyOutcome = {
      nodeId: this.nodeId,
      result: cleanedResult,
      completionReason: reason,
      exitCode,
      timedOut,
      truncated: this.buffer.wasTruncated,
      errorClass,
    };

    void this.materializedPrompt?.cleanup();
    this.emit("complete", outcome);
  }
}

function classifyError(provider: ProviderConfig, chunk: string): ErrorClass {
  const haystack = chunk.toLowerCase();
  if (
    /rate.?limit|429|too many requests|usage limit|quota/.test(haystack) ||
    /rate.?limit|429|too many requests|usage limit|quota/.test(
      provider.error_pattern?.toLowerCase() ?? "",
    )
  ) {
    return "rate-limit";
  }
  return "provider-error";
}

export function isSuccessfulOutcome(outcome: PtyOutcome): boolean {
  if (outcome.errorClass) {
    return false;
  }
  return !outcome.timedOut && (outcome.exitCode === null || outcome.exitCode === 0);
}
