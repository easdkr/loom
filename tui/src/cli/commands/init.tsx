import React, { useEffect } from "react";
import { Box, Text, useApp } from "ink";
import { Banner } from "../../components/Banner.js";

interface InitResultProps {
  configPath: string;
  created: boolean;
  preview: string;
}

export function InitResult(props: InitResultProps) {
  const { exit } = useApp();
  useEffect(() => {
    const timer = setTimeout(() => exit(), 50);
    return () => clearTimeout(timer);
  }, [exit]);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Banner mode="Init" hint={props.configPath} />
      {props.created ? (
        <Text color="green">created {props.configPath}</Text>
      ) : (
        <Text color="yellow">
          {props.configPath} already exists; left untouched.
        </Text>
      )}
      <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
        {props.preview.split(/\r?\n/).map((line, index) => (
          <Text key={`preview-${index}`} color="white">
            {line.length === 0 ? " " : line}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
