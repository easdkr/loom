import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";

interface PromptFormProps {
  label: string;
  initial?: string;
  onSubmit(value: string): void;
  onCancel?(): void;
  helper?: string;
}

export function PromptForm(props: PromptFormProps) {
  const [value, setValue] = useState(props.initial ?? "");

  useInput(
    (_, key) => {
      if (key.escape && props.onCancel) {
        props.onCancel();
      }
    },
    { isActive: Boolean(process.stdin.isTTY) },
  );

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1}>
      <Text color="cyan">{props.label}</Text>
      <TextInput value={value} onChange={setValue} onSubmit={props.onSubmit} focus />
      {props.helper ? <Text color="gray">{props.helper}</Text> : null}
    </Box>
  );
}
