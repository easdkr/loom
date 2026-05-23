import { test } from "node:test";
import assert from "node:assert/strict";
import { compileRegex } from "../src/pty/regex.js";

test("compileRegex translates Rust-style (?m) into the m flag", () => {
  const regex = compileRegex("(?m)^LOOM_EXIT:\\d+\\r?$");
  assert.ok(regex);
  assert.ok(regex!.flags.includes("m"));
  assert.match("first line\nLOOM_EXIT:0\n", regex!);
});

test("compileRegex returns null for blank patterns", () => {
  assert.equal(compileRegex(""), null);
  assert.equal(compileRegex("   "), null);
});

test("compileRegex falls through unchanged when no inline flags", () => {
  const regex = compileRegex("Task complete");
  assert.ok(regex);
  assert.equal(regex!.source, "Task complete");
  assert.equal(regex!.flags, "");
});
