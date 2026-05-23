#!/usr/bin/env node
import { main } from "../src/cli/index.js";

main(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`loom: ${message}\n`);
  process.exit(1);
});
