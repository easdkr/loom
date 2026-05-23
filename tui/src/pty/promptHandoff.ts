import { mkdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";

const INLINE_PROMPT_BYTE_LIMIT = 12 * 1024;

export interface MaterializedPrompt {
  prompt: string;
  cleanup(): Promise<void>;
}

export async function materializePrompt(options: {
  rawPrompt: string;
  workdir?: string;
  nodeId: string;
}): Promise<MaterializedPrompt> {
  if (Buffer.byteLength(options.rawPrompt, "utf8") <= INLINE_PROMPT_BYTE_LIMIT) {
    return { prompt: options.rawPrompt, cleanup: async () => {} };
  }

  const baseDir = options.workdir ?? process.cwd();
  const promptDir = path.join(baseDir, ".omx", "tmp", "prompts");
  await mkdir(promptDir, { recursive: true });
  const file = path.join(promptDir, `${options.nodeId}.txt`);
  await writeFile(file, options.rawPrompt, "utf8");

  return {
    prompt: `The task prompt is too large for safe inline PTY input. Read the full UTF-8 instructions from this file, then complete them: ${file}`,
    cleanup: async () => {
      try {
        await unlink(file);
      } catch {
        // best effort
      }
    },
  };
}
