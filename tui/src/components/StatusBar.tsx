import React from "react";
import { Box, Text } from "ink";

export type StatusLevel = "idle" | "running" | "complete" | "error" | "warning";

const LEVEL_COLOR: Record<StatusLevel, string> = {
  idle: "gray",
  running: "yellow",
  complete: "green",
  error: "red",
  warning: "magenta",
};

const LEVEL_GLYPH: Record<StatusLevel, string> = {
  idle: "·",
  running: "▶",
  complete: "✓",
  error: "✗",
  warning: "!",
};

interface StatusBarProps {
  level: StatusLevel;
  message: string;
  rightHint?: string;
}

export function StatusBar({ level, message, rightHint }: StatusBarProps) {
  const color = LEVEL_COLOR[level];
  return (
    <Box flexDirection="row" justifyContent="space-between" marginTop={1}>
      <Box>
        <Text color={color}>{LEVEL_GLYPH[level]} </Text>
        <Text color={color}>{message}</Text>
      </Box>
      {rightHint ? <Text color="gray">{rightHint}</Text> : null}
    </Box>
  );
}
