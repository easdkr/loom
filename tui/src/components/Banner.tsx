import React from "react";
import { Box, Text } from "ink";

interface BannerProps {
  mode: string;
  hint?: string;
}

export function Banner({ mode, hint }: BannerProps) {
  return (
    <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
      <Box>
        <Text bold color="yellow">
          Loom
        </Text>
        <Text color="gray"> · </Text>
        <Text color="white">{mode}</Text>
      </Box>
      {hint ? <Text color="gray">{hint}</Text> : null}
    </Box>
  );
}
