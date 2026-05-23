import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { materializePrompt } from "../src/pty/promptHandoff.js";

const INLINE_LIMIT = 12 * 1024;

test("short prompts are passed through inline", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loom-promptHandoff-"));
  try {
    const materialized = await materializePrompt({
      rawPrompt: "small task",
      workdir: tmp,
      nodeId: "short",
    });
    assert.equal(materialized.prompt, "small task");
    await materialized.cleanup();
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("large prompts are spilled to .omx/tmp/prompts and cleaned up", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loom-promptHandoff-"));
  try {
    const longPrompt = "한".repeat(INLINE_LIMIT);
    const materialized = await materializePrompt({
      rawPrompt: longPrompt,
      workdir: tmp,
      nodeId: "long",
    });
    const expectedPath = path.join(tmp, ".omx", "tmp", "prompts", "long.txt");
    const exists = await fs.stat(expectedPath).then(() => true).catch(() => false);
    assert.ok(exists, `expected handoff file at ${expectedPath}`);
    assert.ok(
      materialized.prompt.includes(expectedPath),
      `prompt should reference handoff path: ${materialized.prompt}`,
    );
    await materialized.cleanup();
    const stillExists = await fs.stat(expectedPath).then(() => true).catch(() => false);
    assert.equal(stillExists, false, "cleanup should remove the spill file");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
