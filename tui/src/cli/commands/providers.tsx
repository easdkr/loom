import React, { useEffect } from "react";
import { Box, Text, useApp } from "ink";
import type { ProviderConfig } from "../../../../src/providers/types.js";
import { Banner } from "../../components/Banner.js";

interface ProvidersListProps {
  providers: ProviderConfig[];
  configPath: string;
}

export function ProvidersList(props: ProvidersListProps) {
  const { exit } = useApp();

  useEffect(() => {
    const timer = setTimeout(() => exit(), 50);
    return () => clearTimeout(timer);
  }, [exit]);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Banner mode="Providers" hint={props.configPath} />
      {props.providers.length === 0 ? (
        <Text color="yellow">No providers configured.</Text>
      ) : (
        props.providers.map((provider) => (
          <Box key={provider.name} flexDirection="column" marginBottom={1}>
            <Text bold color="cyan">
              {provider.name}
              <Text color="gray"> · {provider.type}</Text>
            </Text>
            <Text color="white">
              {provider.command}
              <Text color="gray">{provider.args.length > 0 ? ` ${provider.args.join(" ")}` : ""}</Text>
            </Text>
            <Text color="gray">
              input_mode={provider.input_mode} · display_mode={provider.display_mode ?? "terminal"} · cols={provider.cols} rows={provider.rows} ·
              completion_timeout_ms={provider.completion_timeout_ms} ·
              idle_timeout_ms={provider.idle_timeout_ms}
            </Text>
            <Text color="gray">
              pattern: <Text color="white">{provider.completion_pattern || "(none)"}</Text>
            </Text>
          </Box>
        ))
      )}
      <Text color="gray">
        Override defaults by editing <Text color="white">{props.configPath}</Text>.
      </Text>
    </Box>
  );
}
