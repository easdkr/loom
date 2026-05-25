import stripAnsi from "strip-ansi";

export type ExecutionTranscriptStatus = "running" | "complete" | "error";

export interface ExecutionTranscriptMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  status: ExecutionTranscriptStatus;
}

const CONTROL_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const VT_CHARSET_ESCAPES = /\u001b[()*+][A-Z0-9]/g;

export function sanitizeTranscriptText(value: string): string {
  return stripAnsi(value).replace(VT_CHARSET_ESCAPES, "").replace(CONTROL_TEXT, "");
}

export function createUserTranscript(prompt: string): ExecutionTranscriptMessage[] {
  const text = sanitizeTranscriptText(prompt).trim();
  if (!text) {
    return [];
  }
  return [{ id: "user-0", role: "user", content: text, status: "complete" }];
}

export function appendSystemMessage(
  messages: ExecutionTranscriptMessage[],
  status: ExecutionTranscriptStatus,
  text: string,
): ExecutionTranscriptMessage[] {
  const cleaned = sanitizeTranscriptText(text).trim();
  if (!cleaned) {
    return messages;
  }
  return [
    ...messages,
    {
      id: `system-${messages.length}`,
      role: "system",
      content: cleaned,
      status,
    },
  ];
}
