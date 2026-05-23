#!/usr/bin/env node
// pnpm extracts node-pty's prebuilt spawn-helper without the exec bit, which
// makes posix_spawnp fail at runtime. Re-add it after every install.
import { chmodSync, statSync } from "node:fs";
import { execSync } from "node:child_process";

const candidates = [];

try {
  const stdout = execSync(
    "find node_modules -type f -name spawn-helper -path '*node-pty*'",
    { encoding: "utf8" },
  );
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      candidates.push(trimmed);
    }
  }
} catch (error) {
  // node_modules may not exist yet (e.g. dry runs); leave silently
  process.exit(0);
}

let fixed = 0;
for (const path of candidates) {
  try {
    const mode = statSync(path).mode;
    if ((mode & 0o111) !== 0o111) {
      chmodSync(path, mode | 0o111);
      fixed += 1;
    }
  } catch {
    // best effort
  }
}

if (fixed > 0) {
  process.stdout.write(`loom: chmod +x on ${fixed} node-pty spawn-helper file(s)\n`);
}
