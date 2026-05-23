import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanForDisplay, normalizeDisplayText, stripAnsi } from "../src/pty/ansi.js";

test("stripAnsi removes SGR sequences", () => {
  assert.equal(stripAnsi("[31mred[0m"), "red");
});

test("normalizeDisplayText drops private-use codepoints and replaces FFFD", () => {
  assert.equal(normalizeDisplayText("missing"), "missing");
  assert.equal(normalizeDisplayText("bad�text"), "bad?text");
});

test("cleanForDisplay preserves Korean characters", () => {
  const noisy = "[33m한글 ✓ →[0m";
  assert.equal(cleanForDisplay(noisy), "한글 ✓ →");
});
