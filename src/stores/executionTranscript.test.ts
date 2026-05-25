import test from "node:test";
import assert from "node:assert/strict";
import { appendSystemMessage, createUserTranscript } from "./executionTranscript";
import { disposeExecutionStore, getExecutionStore } from "./executionStore";

test("createUserTranscript records the prompt as a completed user message", () => {
  assert.deepEqual(createUserTranscript("Run the plan"), [
    { id: "user-0", role: "user", content: "Run the plan", status: "complete" },
  ]);
});

test("appendSystemMessage appends sanitized status text", () => {
  const messages = appendSystemMessage(
    createUserTranscript("Prompt"),
    "complete",
    "\u001b[32mProcess finished\u001b[0m",
  );

  assert.deepEqual(messages, [
    { id: "user-0", role: "user", content: "Prompt", status: "complete" },
    { id: "system-1", role: "system", content: "Process finished", status: "complete" },
  ]);
});

test("execution store keeps running agent output out of conversation messages", () => {
  const projectId = "execution-agent-store";
  const store = getExecutionStore(projectId);

  try {
    store.getState().beginRun("run-1", ["node-1"]);
    store.getState().beginTranscript("node-1", "Prompt");

    const rawChunk = "\u001b[31mred\u001b[0m\r\u0007";
    store.getState().appendOutput("node-1", rawChunk);
    store
      .getState()
      .applyAgentTranscript("node-1", "Rust-rendered answer", "* Thinking...(2s)");

    const state = store.getState();
    assert.equal(state.outputByNode["node-1"], rawChunk);
    assert.equal(state.activityByNode["node-1"], "* Thinking...(2s)");
    assert.deepEqual(state.transcriptByNode["node-1"], [
      { id: "user-0", role: "user", content: "Prompt", status: "complete" },
    ]);
  } finally {
    disposeExecutionStore(projectId);
  }
});

test("completeTranscript marks Rust agent content complete and clears activity", async () => {
  const projectId = "execution-complete-store";
  const store = getExecutionStore(projectId);

  try {
    store.getState().beginRun("run-1", ["node-1"]);
    store.getState().beginTranscript("node-1", "Prompt");
    store.getState().applyAgentTranscript("node-1", "done", "* Thinking...(2s)");
    await store.getState().completeTranscript("node-1", "Process finished successfully");

    assert.equal(store.getState().activityByNode["node-1"], undefined);
    assert.deepEqual(store.getState().transcriptByNode["node-1"], [
      { id: "user-0", role: "user", content: "Prompt", status: "complete" },
      { id: "assistant-1", role: "assistant", content: "done", status: "complete" },
      {
        id: "system-2",
        role: "system",
        content: "Process finished successfully",
        status: "complete",
      },
    ]);
  } finally {
    disposeExecutionStore(projectId);
  }
});

test("completeTranscript does not render an empty assistant card", async () => {
  const projectId = "execution-empty-assistant-store";
  const store = getExecutionStore(projectId);

  try {
    store.getState().beginRun("run-1", ["node-1"]);
    store.getState().beginTranscript("node-1", "Prompt");
    await store.getState().completeTranscript("node-1", "Process finished successfully");

    assert.deepEqual(store.getState().transcriptByNode["node-1"], [
      { id: "user-0", role: "user", content: "Prompt", status: "complete" },
      {
        id: "system-1",
        role: "system",
        content: "Process finished successfully",
        status: "complete",
      },
    ]);
  } finally {
    disposeExecutionStore(projectId);
  }
});

test("failTranscript marks Rust agent content failed and appends error text", async () => {
  const projectId = "execution-error-store";
  const store = getExecutionStore(projectId);

  try {
    store.getState().beginRun("run-1", ["node-1"]);
    store.getState().beginTranscript("node-1", "Prompt");
    store.getState().applyAgentTranscript("node-1", "partial", undefined);
    await store.getState().failTranscript("node-1", "Provider disconnected");

    assert.deepEqual(store.getState().transcriptByNode["node-1"], [
      { id: "user-0", role: "user", content: "Prompt", status: "complete" },
      { id: "assistant-1", role: "assistant", content: "partial", status: "error" },
      { id: "system-2", role: "system", content: "Provider disconnected", status: "error" },
    ]);
  } finally {
    disposeExecutionStore(projectId);
  }
});

test("agent session separates follow-up turns from earlier assistant content", async () => {
  const projectId = "execution-followup-store";
  const store = getExecutionStore(projectId);

  try {
    store.getState().beginRun("run-1", ["node-1"]);
    store.getState().beginTranscript("node-1", "First question");
    store.getState().applyAgentTranscript("node-1", "Initial assistant reply.", undefined);
    await store.getState().appendUserMessage("node-1", "Follow-up question");
    store
      .getState()
      .applyAgentTranscript(
        "node-1",
        "Initial assistant reply.\nSecond assistant reply.",
        undefined,
      );
    await store.getState().completeTranscript("node-1", "Process finished successfully");

    const transcript = store.getState().transcriptByNode["node-1"];

    assert.deepEqual(
      transcript.map((message) => message.role),
      ["user", "assistant", "user", "assistant", "system"],
    );
    assert.equal(transcript[1]?.content, "Initial assistant reply.");
    assert.equal(transcript[2]?.content, "Follow-up question");
    assert.equal(transcript[3]?.content, "Second assistant reply.");
  } finally {
    disposeExecutionStore(projectId);
  }
});

test("agent session removes echoed user prompt from assistant turns", async () => {
  const projectId = "execution-echoed-user-prompt-store";
  const store = getExecutionStore(projectId);

  try {
    store.getState().beginRun("run-1", ["node-1"]);
    store.getState().beginTranscript("node-1", "echo hello from loom");
    store.getState().applyAgentTranscript("node-1", "echo hello from loom", undefined);
    await store.getState().appendUserMessage("node-1", "안녕");
    store.getState().applyAgentTranscript("node-1", "echo hello from loom\n안녕\n안녕하세요!", undefined);
    await store.getState().completeTranscript("node-1", "Process finished successfully");

    const transcript = store.getState().transcriptByNode["node-1"];

    assert.deepEqual(
      transcript.map((message) => message.role),
      ["user", "user", "assistant", "system"],
    );
    assert.equal(transcript[0]?.content, "echo hello from loom");
    assert.equal(transcript[1]?.content, "안녕");
    assert.equal(transcript[2]?.content, "안녕하세요!");
  } finally {
    disposeExecutionStore(projectId);
  }
});
