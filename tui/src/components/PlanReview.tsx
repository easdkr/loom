import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type { PlanDraft, PlanDraftNode } from "../plan/planSchema.js";
import {
  insertNodeAfter,
  moveNode,
  removeNode,
  updateNode,
} from "../plan/planSchema.js";
import type { ProviderConfig } from "../../../src/providers/types.js";

type EditField = "prompt" | "provider" | "id" | null;

interface PlanReviewProps {
  draft: PlanDraft;
  providers: ProviderConfig[];
  onChange(draft: PlanDraft): void;
  onApprove(): void;
  onCancel(): void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function nextProvider(providers: ProviderConfig[], current: string): string {
  if (providers.length === 0) {
    return current;
  }
  const index = providers.findIndex((provider) => provider.name === current);
  const nextIndex = (index + 1) % providers.length;
  return providers[nextIndex]!.name;
}

function summarizePrompt(prompt: string, maxLength: number): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function freshNode(providers: ProviderConfig[], anchor: PlanDraftNode | null): PlanDraftNode {
  const provider = anchor?.provider ?? providers[0]?.name ?? "shell";
  const id = `node-${Date.now().toString(36)}`;
  return {
    id,
    provider,
    prompt: "",
    type: "worker:pty",
  };
}

export function PlanReview(props: PlanReviewProps) {
  const { draft, providers, onChange, onApprove, onCancel } = props;
  const [cursor, setCursor] = useState(0);
  const [editing, setEditing] = useState<EditField>(null);
  const [editBuffer, setEditBuffer] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);

  const safeCursor = clamp(cursor, 0, Math.max(0, draft.nodes.length - 1));
  const current = draft.nodes[safeCursor];

  const totalActive = useMemo(
    () => draft.nodes.filter((node) => !node.skipped).length,
    [draft.nodes],
  );

  useInput(
    (input, key) => {
    if (editing) {
      if (key.escape) {
        setEditing(null);
        setEditBuffer("");
      }
      return;
    }

    if (key.ctrl && input === "c") {
      onCancel();
      return;
    }

    if (key.return) {
      if (totalActive === 0) {
        setFeedback("at least one node must be active");
        return;
      }
      onApprove();
      return;
    }

    if (key.upArrow || input === "k") {
      setCursor((value) => clamp(value - 1, 0, draft.nodes.length - 1));
      return;
    }
    if (key.downArrow || input === "j") {
      setCursor((value) => clamp(value + 1, 0, draft.nodes.length - 1));
      return;
    }

    if (!current) {
      if (input?.toLowerCase() === "a") {
        const next = freshNode(providers, null);
        const inserted = insertNodeAfter(draft, -1, next);
        onChange(inserted);
        setCursor(0);
      }
      return;
    }

    switch (input?.toLowerCase()) {
      case "e": {
        setEditing("prompt");
        setEditBuffer(current.prompt);
        break;
      }
      case "i": {
        setEditing("id");
        setEditBuffer(current.id);
        break;
      }
      case "r": {
        const provider = nextProvider(providers, current.provider);
        onChange(updateNode(draft, safeCursor, { provider }));
        break;
      }
      case "s": {
        onChange(updateNode(draft, safeCursor, { skipped: !current.skipped }));
        break;
      }
      case "a": {
        const inserted = insertNodeAfter(draft, safeCursor, freshNode(providers, current));
        onChange(inserted);
        setCursor(safeCursor + 1);
        break;
      }
      case "d": {
        if (draft.nodes.length <= 1) {
          setFeedback("cannot remove the last node");
          break;
        }
        onChange(removeNode(draft, safeCursor));
        setCursor(clamp(safeCursor, 0, draft.nodes.length - 2));
        break;
      }
      case "m":
      case "[": {
        const updated = moveNode(draft, safeCursor, safeCursor - 1);
        onChange(updated);
        setCursor(clamp(safeCursor - 1, 0, updated.nodes.length - 1));
        break;
      }
      case "]": {
        const updated = moveNode(draft, safeCursor, safeCursor + 1);
        onChange(updated);
        setCursor(clamp(safeCursor + 1, 0, updated.nodes.length - 1));
        break;
      }
      case "q": {
        onCancel();
        break;
      }
      default:
        if (key.escape) {
          onCancel();
        }
    }
    },
    { isActive: Boolean(process.stdin.isTTY) },
  );

  function commitEdit(): void {
    if (!editing || !current) {
      return;
    }
    if (editing === "prompt") {
      onChange(updateNode(draft, safeCursor, { prompt: editBuffer }));
    } else if (editing === "provider") {
      onChange(updateNode(draft, safeCursor, { provider: editBuffer }));
    } else if (editing === "id") {
      const trimmed = editBuffer.trim();
      if (trimmed.length === 0) {
        setFeedback("node id cannot be empty");
      } else if (
        draft.nodes.some((node, index) => index !== safeCursor && node.id === trimmed)
      ) {
        setFeedback(`duplicate node id: ${trimmed}`);
      } else {
        onChange(updateNode(draft, safeCursor, { id: trimmed }));
      }
    }
    setEditing(null);
    setEditBuffer("");
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1} flexDirection="column">
        <Text color="gray">
          Origin: <Text color="white">{summarizePrompt(draft.origin, 200)}</Text>
        </Text>
        <Text color="gray">
          Mode: <Text color="white">{draft.mode}</Text>
          {"   "}
          Nodes: <Text color="white">{draft.nodes.length}</Text> ({totalActive} active)
        </Text>
      </Box>

      {draft.nodes.length === 0 ? (
        <Text color="yellow">No nodes. Press 'a' to add a node.</Text>
      ) : (
        <Box flexDirection="column">
          {draft.nodes.map((node, index) => {
            const selected = index === safeCursor;
            const color = node.skipped ? "magenta" : selected ? "yellow" : "white";
            const indicator = selected ? "›" : " ";
            const skipMark = node.skipped ? " [skipped]" : "";
            return (
              <Box key={node.id} flexDirection="column">
                <Text color={color}>
                  {indicator} {String(index + 1).padStart(2, "0")} {node.id}
                  {skipMark}
                </Text>
                <Box paddingLeft={4} flexDirection="column">
                  <Text color="cyan">provider: {node.provider}</Text>
                  <Text color="gray">prompt: {summarizePrompt(node.prompt, 140)}</Text>
                </Box>
              </Box>
            );
          })}
        </Box>
      )}

      {editing && current ? (
        <Box marginTop={1} flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1}>
          <Text color="cyan">edit {editing} for {current.id}</Text>
          <TextInput
            value={editBuffer}
            onChange={setEditBuffer}
            onSubmit={() => commitEdit()}
            focus
          />
          <Text color="gray">enter to save · esc to cancel</Text>
        </Box>
      ) : null}

      {feedback ? (
        <Box marginTop={1}>
          <Text color="magenta">! {feedback}</Text>
        </Box>
      ) : null}

      <Box marginTop={1} flexDirection="column">
        <Text color="gray">
          ↑/↓ navigate · e edit prompt · r cycle provider · s skip · a add · d remove · [ ] move · enter approve · esc cancel
        </Text>
      </Box>
    </Box>
  );
}
