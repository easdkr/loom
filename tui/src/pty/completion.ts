import { stripAnsi } from "./ansi.js";

export const DEFAULT_TAIL_WINDOW_BYTES = 32 * 1024;
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
export const DEFAULT_SETTLE_MS = 800;

export type DetectionKind = "completion" | "error";

export interface Detection {
  kind: DetectionKind;
  matchedAt: number;
}

export interface CompletionDetectorOptions {
  completionPattern: RegExp | null;
  errorPattern: RegExp | null;
  tailWindowBytes?: number;
  settleMs?: number;
  now?: () => number;
}

/**
 * Incremental completion / error detector.
 *
 * Maintains a fixed-size raw tail (`tailWindowBytes`) so we never re-scan the
 * full PTY output on each chunk. Pattern matching is performed against the
 * stripped tail only; this is O(tail) per chunk instead of O(total) per chunk.
 *
 * Completion is gated by a settle window: once the completion pattern matches,
 * we wait `settleMs` of additional silence before finalizing — that defends
 * against false positives where the model briefly echoes a completion-looking
 * phrase mid-thought.
 */
export class CompletionDetector {
  private readonly completionPattern: RegExp | null;
  private readonly errorPattern: RegExp | null;
  private readonly tailWindowBytes: number;
  private readonly settleMs: number;
  private readonly now: () => number;
  private tail = "";
  private completionMatchedAt: number | null = null;
  private errorMatchedAt: number | null = null;

  constructor(options: CompletionDetectorOptions) {
    this.completionPattern = options.completionPattern;
    this.errorPattern = options.errorPattern;
    this.tailWindowBytes = Math.max(1024, options.tailWindowBytes ?? DEFAULT_TAIL_WINDOW_BYTES);
    this.settleMs = Math.max(0, options.settleMs ?? DEFAULT_SETTLE_MS);
    this.now = options.now ?? Date.now;
  }

  push(chunk: string): Detection | null {
    if (chunk.length === 0) {
      return null;
    }

    this.tail += chunk;
    if (this.tail.length > this.tailWindowBytes * 2) {
      this.tail = this.tail.slice(-this.tailWindowBytes);
    }

    const stripped = stripAnsi(this.tail);

    if (this.errorPattern && this.errorPattern.test(stripped)) {
      if (this.errorMatchedAt === null) {
        this.errorMatchedAt = this.now();
      }
      return { kind: "error", matchedAt: this.errorMatchedAt };
    }

    if (this.completionPattern && this.completionPattern.test(stripped)) {
      if (this.completionMatchedAt === null) {
        this.completionMatchedAt = this.now();
      }
      return { kind: "completion", matchedAt: this.completionMatchedAt };
    }

    // No tail match — reset settle clock so a later match starts a fresh window.
    this.completionMatchedAt = null;
    return null;
  }

  /**
   * Returns true if the most recent completion match has stayed quiet long
   * enough to be considered final. Caller should check this on idle ticks
   * (no new data arriving) to avoid finalizing while output is still streaming.
   */
  isSettled(lastOutputAt: number): boolean {
    if (this.completionMatchedAt === null) {
      return false;
    }
    const idleFor = this.now() - lastOutputAt;
    const heldFor = this.now() - this.completionMatchedAt;
    return idleFor >= this.settleMs && heldFor >= this.settleMs;
  }

  hasErrorDetection(): boolean {
    return this.errorMatchedAt !== null;
  }

  resetCompletion(): void {
    this.completionMatchedAt = null;
  }
}

/**
 * Bounded FIFO byte buffer that retains the last N bytes of streamed output.
 * Tracks whether truncation occurred so callers can flag the outcome.
 */
export class BoundedBuffer {
  private readonly maxBytes: number;
  private chunks: string[] = [];
  private size = 0;
  private truncated = false;

  constructor(maxBytes: number = DEFAULT_MAX_OUTPUT_BYTES) {
    this.maxBytes = Math.max(4096, maxBytes);
  }

  append(chunk: string): void {
    if (chunk.length === 0) {
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.maxBytes && this.chunks.length > 1) {
      const head = this.chunks.shift();
      if (head === undefined) {
        break;
      }
      this.size -= head.length;
      this.truncated = true;
    }
    if (this.size > this.maxBytes && this.chunks.length === 1) {
      const only = this.chunks[0]!;
      this.chunks[0] = only.slice(-this.maxBytes);
      this.size = this.chunks[0]!.length;
      this.truncated = true;
    }
  }

  toString(): string {
    return this.chunks.join("");
  }

  get wasTruncated(): boolean {
    return this.truncated;
  }

  get byteLength(): number {
    return this.size;
  }
}
