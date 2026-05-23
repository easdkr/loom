import type { ProviderConfig } from "../../../src/providers/types.js";

export function promptForProvider(provider: ProviderConfig, prompt: string): string {
  if (provider.name === "shell" && provider.input_mode === "append-arg") {
    return `${prompt}\nloom_status=$?\nprintf '\\nLOOM_EXIT:%s\\n' "$loom_status"\nexit "$loom_status"`;
  }
  return prompt;
}
