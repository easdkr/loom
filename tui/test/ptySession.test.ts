import { test } from "node:test";
import assert from "node:assert/strict";
import { fallbackProviders } from "../../src/providers/index.js";
import { PtySession, isSuccessfulOutcome, type PtyOutcome } from "../src/pty/ptySession.js";

const shellProvider = fallbackProviders.find((provider) => provider.name === "shell");
if (!shellProvider) {
  throw new Error("shell provider missing from fallback registry");
}

function runShell(prompt: string): Promise<PtyOutcome> {
  return new Promise<PtyOutcome>((resolve, reject) => {
    const session = new PtySession({
      nodeId: `test-${Date.now().toString(36)}`,
      provider: shellProvider!,
      prompt,
      timeoutMs: 15_000,
    });
    session.on("complete", resolve);
    session.start().catch(reject);
  });
}

test(
  "shell provider PTY echoes a marker and detects completion",
  { timeout: 30_000 },
  async () => {
    const outcome = await runShell("printf 'loom-pty-smoke %s\\n' 'OK'");
    assert.equal(outcome.timedOut, false);
    assert.equal(outcome.exitCode, 0);
    assert.match(outcome.result, /loom-pty-smoke OK/);
    assert.equal(isSuccessfulOutcome(outcome), true);
    assert.equal(outcome.completionReason, "completion-pattern");
  },
);

test(
  "shell provider PTY captures non-zero exit codes",
  { timeout: 30_000 },
  async () => {
    const outcome = await runShell("printf 'before exit\\n' && false");
    assert.equal(outcome.timedOut, false);
    assert.notEqual(outcome.exitCode, 0);
    assert.equal(isSuccessfulOutcome(outcome), false);
  },
);
