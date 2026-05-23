import { EventEmitter } from "node:events";
import { PtySession, type PtyOutcome, type PtySessionOptions } from "./ptySession.js";

export interface MultiplexerSnapshot {
  active: string[];
  completed: Record<string, PtyOutcome>;
}

export interface SessionChunk {
  nodeId: string;
  chunk: string;
}

export class PtyMultiplexer extends EventEmitter {
  private readonly sessions = new Map<string, PtySession>();
  private readonly outcomes = new Map<string, PtyOutcome>();
  private readonly limit: number;
  private readonly pending: Array<{ options: PtySessionOptions; resolve: (session: PtySession) => void; reject: (error: unknown) => void }> = [];

  constructor(options: { concurrencyLimit?: number } = {}) {
    super();
    this.limit = Math.max(1, options.concurrencyLimit ?? 4);
  }

  get activeCount(): number {
    return this.sessions.size;
  }

  get capacity(): number {
    return this.limit;
  }

  list(): string[] {
    return Array.from(this.sessions.keys());
  }

  getOutcome(nodeId: string): PtyOutcome | undefined {
    return this.outcomes.get(nodeId);
  }

  snapshot(): MultiplexerSnapshot {
    return {
      active: this.list(),
      completed: Object.fromEntries(this.outcomes.entries()),
    };
  }

  async spawn(options: PtySessionOptions): Promise<PtySession> {
    if (this.sessions.size >= this.limit) {
      return await new Promise<PtySession>((resolve, reject) => {
        this.pending.push({ options, resolve, reject });
      });
    }
    return await this.spawnNow(options);
  }

  write(nodeId: string, input: string): void {
    this.sessions.get(nodeId)?.write(input);
  }

  resize(nodeId: string, cols: number, rows: number): void {
    this.sessions.get(nodeId)?.resize(cols, rows);
  }

  kill(nodeId: string): void {
    this.sessions.get(nodeId)?.kill();
  }

  killAll(): void {
    for (const session of this.sessions.values()) {
      session.kill();
    }
    while (this.pending.length > 0) {
      const next = this.pending.shift();
      next?.reject(new Error("multiplexer killed before launch"));
    }
  }

  private async spawnNow(options: PtySessionOptions): Promise<PtySession> {
    const session = new PtySession(options);
    this.sessions.set(options.nodeId, session);

    session.on("data", (chunk: string) => {
      this.emit("data", { nodeId: options.nodeId, chunk } satisfies SessionChunk);
    });
    session.on("complete", (outcome: PtyOutcome) => {
      this.sessions.delete(options.nodeId);
      this.outcomes.set(options.nodeId, outcome);
      this.emit("complete", outcome);
      this.drainPending();
    });

    try {
      await session.start();
    } catch (error) {
      this.sessions.delete(options.nodeId);
      const message = error instanceof Error ? error.message : String(error);
      this.emit("error", { nodeId: options.nodeId, error: message });
      this.drainPending();
      throw error;
    }
    this.emit("start", { nodeId: options.nodeId });
    return session;
  }

  private drainPending(): void {
    while (this.sessions.size < this.limit && this.pending.length > 0) {
      const next = this.pending.shift();
      if (!next) {
        return;
      }
      this.spawnNow(next.options).then(next.resolve, next.reject);
    }
  }
}
