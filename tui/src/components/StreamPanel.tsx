import React from "react";
import { Box, Text } from "ink";
import { cleanForDisplay } from "../pty/ansi.js";

export interface StreamPanelProps {
  nodeId: string;
  provider: string;
  status: "pending" | "running" | "complete" | "error" | "skipped";
  buffer: string;
  rows?: number;
  cols?: number;
}

const STATUS_COLOR = {
  pending: "gray",
  running: "yellow",
  complete: "green",
  error: "red",
  skipped: "magenta",
} as const;

const STATUS_GLYPH = {
  pending: "·",
  running: "▶",
  complete: "✓",
  error: "✗",
  skipped: "—",
} as const;

function tailLines(input: string, max: number, cols: number): string[] {
  const cleaned = cleanForDisplay(input);
  if (cleaned.length === 0) {
    return [];
  }
  const rawLines = cleaned.split(/\r?\n/);
  const wrapped: string[] = [];
  for (const raw of rawLines) {
    if (raw.length === 0) {
      wrapped.push("");
      continue;
    }
    if (cols <= 0 || raw.length <= cols) {
      wrapped.push(raw);
      continue;
    }
    for (let i = 0; i < raw.length; i += cols) {
      wrapped.push(raw.slice(i, i + cols));
    }
  }
  return wrapped.slice(-max);
}

export function StreamPanel(props: StreamPanelProps) {
  const rows = Math.max(3, props.rows ?? 10);
  const cols = Math.max(20, props.cols ?? 80);
  const visible = tailLines(props.buffer, rows, cols);
  const padding = Math.max(0, rows - visible.length);
  const placeholderRows = Array.from({ length: padding }, () => "");
  const lines = [...placeholderRows, ...visible];
  const color = STATUS_COLOR[props.status];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} marginBottom={1}>
      <Box paddingX={1} flexDirection="row" justifyContent="space-between">
        <Box>
          <Text color={color}>{STATUS_GLYPH[props.status]} </Text>
          <Text bold>{props.nodeId}</Text>
          <Text color="gray"> · </Text>
          <Text color="cyan">{props.provider}</Text>
        </Box>
        <Text color={color}>{props.status}</Text>
      </Box>
      <Box paddingX={1} flexDirection="column">
        {lines.map((line, index) => (
          <Text key={`${props.nodeId}-${index}`} color="white" wrap="truncate">
            {line.length === 0 ? " " : line}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
