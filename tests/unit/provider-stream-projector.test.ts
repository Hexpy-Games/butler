import { expect, test } from "bun:test";
import { createProviderStreamTurnEventProjector } from "../../packages/butler-agent/src/agent/turn/native/stream/provider-stream-projector.ts";
import type { RuntimeTurnEventInput } from "../../packages/butler-agent/src/test-support/harness/contracts.ts";

test("provider stream projector emits public text deltas and preserves final reconstruction independence", async () => {
  const events: RuntimeTurnEventInput[] = [];
  const projector = createProviderStreamTurnEventProjector({
    turnId: "turn-stream-1",
    defaultStreamId: "stream-default",
    emitTurnEvent: (event) => {
      events.push(event);
    },
  });

  await projector.project({
    type: "text_delta",
    streamId: "stream-text-1",
    sequence: 1,
    textDelta: "Checking the current contract.",
    target: "public_note",
  });
  await projector.completeOpenStreams("completed");

  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({
    kind: "model.stream.text_delta",
    visibility: "public",
    payload: {
      streamId: "stream-text-1",
      sequence: 1,
      textDelta: "Checking the current contract.",
      target: "public_note",
    },
  });
  expect(events[1]).toMatchObject({
    kind: "model.stream.completed",
    visibility: "internal",
    payload: {
      streamId: "stream-text-1",
      status: "completed",
    },
  });
});

test("provider stream projector records reasoning as internal counts only", async () => {
  const events: RuntimeTurnEventInput[] = [];
  const projector = createProviderStreamTurnEventProjector({
    turnId: "turn-stream-2",
    defaultStreamId: "stream-reasoning-1",
    emitTurnEvent: (event) => {
      events.push(event);
    },
  });

  await projector.project({
    type: "reasoning_delta",
    sequence: 7,
    textDelta: "hidden chain-of-thought should never be copied",
  });

  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    kind: "model.stream.reasoning_delta",
    visibility: "internal",
    payload: {
      streamId: "stream-reasoning-1",
      sequence: 7,
      charCount: "hidden chain-of-thought should never be copied".length,
    },
  });
  expect(JSON.stringify(events[0])).not.toContain("hidden chain-of-thought");
});

test("provider stream projector keeps tool-call argument deltas internal without fake tool execution", async () => {
  const events: RuntimeTurnEventInput[] = [];
  const projector = createProviderStreamTurnEventProjector({
    turnId: "turn-stream-3",
    defaultStreamId: "stream-tool-1",
    emitTurnEvent: (event) => {
      events.push(event);
    },
  });

  await projector.project({
    type: "tool_call_delta",
    streamId: "stream-tool-1",
    callIndex: 0,
    sequence: 2,
    toolCallId: "call-safe-id",
    toolName: "run_command",
    argumentsDelta: "{\"command\":\"printf private\"",
    publicState: "generating",
  });

  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    kind: "model.stream.tool_call_delta",
    visibility: "internal",
    payload: {
      streamId: "stream-tool-1",
      callIndex: 0,
      sequence: 2,
      toolCallId: "call-safe-id",
      safeToolName: "run_command",
      argumentCharCount: "{\"command\":\"printf private\"".length,
      rawArgumentsDelta: "{\"command\":\"printf private\"",
      publicState: "generating",
    },
  });
  expect(events.map((event) => event.kind)).not.toContain("tool.started");
  expect(events.map((event) => event.kind)).not.toContain("tool.completed");
});

test("provider stream projector deduplicates stream chunks by identity and sequence", async () => {
  const events: RuntimeTurnEventInput[] = [];
  const projector = createProviderStreamTurnEventProjector({
    turnId: "turn-stream-4",
    defaultStreamId: "stream-dedupe",
    emitTurnEvent: (event) => {
      events.push(event);
    },
  });
  const duplicateChunk = {
    type: "tool_call_delta" as const,
    streamId: "stream-dedupe",
    callIndex: 1,
    sequence: 4,
    argumentsDelta: "{\"path\"",
  };

  await projector.project(duplicateChunk);
  await projector.project(duplicateChunk);
  await projector.completeOpenStreams("completed");
  await projector.completeOpenStreams("completed");

  expect(events).toHaveLength(2);
  expect(events[0]?.kind).toBe("model.stream.tool_call_delta");
  expect(events[1]).toMatchObject({
    kind: "model.stream.completed",
    payload: {
      streamId: "stream-dedupe",
      status: "completed",
    },
  });
});
