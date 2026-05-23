import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BoundedBuffer,
  CompletionDetector,
  DEFAULT_MAX_OUTPUT_BYTES,
} from "../src/pty/completion.js";
import { compileRegex } from "../src/pty/regex.js";

function staticClock(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)]!;
}

test("CompletionDetector matches completion pattern on tail", () => {
  const detector = new CompletionDetector({
    completionPattern: compileRegex("(?m)^LOOM_EXIT:\\d+$"),
    errorPattern: null,
    now: staticClock([1000]),
  });

  assert.equal(detector.push("preamble line\n"), null);
  const detection = detector.push("more\nLOOM_EXIT:0\n");
  assert.ok(detection);
  assert.equal(detection?.kind, "completion");
});

test("CompletionDetector reports error before completion if both match", () => {
  const detector = new CompletionDetector({
    completionPattern: compileRegex("Done"),
    errorPattern: compileRegex("rate.?limit"),
    now: staticClock([100, 200]),
  });

  const detection = detector.push("got rate-limit signal\nDone\n");
  assert.equal(detection?.kind, "error");
});

test("CompletionDetector settle requires both idle and held duration", () => {
  let now = 1000;
  const detector = new CompletionDetector({
    completionPattern: compileRegex("Done"),
    errorPattern: null,
    settleMs: 500,
    now: () => now,
  });

  const detection = detector.push("Done\n");
  assert.ok(detection);
  assert.equal(detector.isSettled(now), false, "no idle time yet");

  now += 600;
  assert.equal(detector.isSettled(now - 600), true, "settled after held + idle");
});

test("CompletionDetector strips ANSI codes before matching", () => {
  const detector = new CompletionDetector({
    completionPattern: compileRegex("Task complete"),
    errorPattern: null,
  });
  const detection = detector.push("\x1b[32mTask complete\x1b[0m");
  assert.ok(detection);
  assert.equal(detection?.kind, "completion");
});

test("CompletionDetector tail window resets settle on intermediate non-match", () => {
  let now = 1000;
  const detector = new CompletionDetector({
    completionPattern: compileRegex("Done"),
    errorPattern: null,
    tailWindowBytes: 1024,
    settleMs: 300,
    now: () => now,
  });

  let detection = detector.push("Done\n");
  assert.equal(detection?.kind, "completion");
  const firstMatch = detection!.matchedAt;

  // Push enough new content to evict "Done" from the tail window (tail*2 threshold).
  detection = detector.push("x".repeat(4096));
  assert.equal(detection, null, "non-matching tail clears settle clock");

  now += 400;
  detection = detector.push("Done\n");
  assert.equal(detection?.kind, "completion");
  assert.notEqual(detection!.matchedAt, firstMatch, "fresh match starts a new settle window");
});

test("BoundedBuffer keeps recent bytes and flags truncation", () => {
  const buffer = new BoundedBuffer(8 * 1024);
  buffer.append("a".repeat(4096));
  assert.equal(buffer.wasTruncated, false);
  buffer.append("b".repeat(8192));
  assert.equal(buffer.wasTruncated, true);
  const value = buffer.toString();
  assert.ok(value.length <= 8192);
  assert.match(value.slice(-1), /b/);
});

test("BoundedBuffer enforces minimum capacity", () => {
  const buffer = new BoundedBuffer(10);
  buffer.append("x".repeat(8192));
  assert.ok(buffer.byteLength >= 4096, "minimum capacity prevents pathological clipping");
});

test("DEFAULT_MAX_OUTPUT_BYTES is at least 1 MiB", () => {
  assert.ok(DEFAULT_MAX_OUTPUT_BYTES >= 1024 * 1024);
});
