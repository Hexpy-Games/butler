import { expect, test } from "bun:test";
import {
  classifyForConversation,
  TRANSCRIPT_TOP_LEVEL_EVENT_KINDS,
} from "../../packages/butler-agent/src/agent/conversation/admission.ts";

test("classifier covers every current transcript top-level event kind", () => {
  expect(TRANSCRIPT_TOP_LEVEL_EVENT_KINDS).toEqual([
    "inbound",
    "outbound",
    "delivery",
    "turn",
    "tool_call",
    "tool_result",
    "worker_status",
    "session_status",
    "memory_note",
    "system",
  ]);

  const decisions = TRANSCRIPT_TOP_LEVEL_EVENT_KINDS.map((kind) =>
    classifyForConversation({
      source: "transcript",
      kind,
      payload: {},
      metadata: {},
    }),
  );
  expect(decisions.every((decision) => decision.className)).toBe(true);
  expect(decisions.every((decision) => decision.admitted === false)).toBe(true);
});

test("classifier admits only canonical gateway inbound and final outbound shapes", () => {
  const inbound = classifyForConversation({
    source: "gateway",
    kind: "inbound.accepted",
    role: "user",
    text: "hello",
    sourceGateway: "app",
    sourceRef: "event-1",
  });
  const final = classifyForConversation({
    source: "gateway",
    kind: "outbound.final",
    role: "assistant",
    text: "answer",
    sourceGateway: "app",
    sourceRef: "runtime-final:turn-1",
  });
  const transcriptText = classifyForConversation({
    source: "transcript",
    kind: "inbound",
    payload: {
      eventId: "event-1",
      message: { text: "do not parse transcript payload text" },
    },
    metadata: { source: "gateway-actor" },
  });

  expect(inbound).toMatchObject({
    admitted: true,
    className: "semantic_message",
    operation: { kind: "append_message", role: "user", text: "hello" },
  });
  expect(final).toMatchObject({
    admitted: true,
    className: "semantic_message",
    operation: { kind: "append_message", role: "assistant", text: "answer" },
  });
  expect(transcriptText).toMatchObject({
    admitted: false,
    className: "audit_event",
  });
});

test("streaming and unknown runtime events are non-semantic by default", () => {
  expect(classifyForConversation({
    source: "runtime_turn_event",
    kind: "model.stream.text_delta",
    payload: { textDelta: "hel", target: "final_candidate" },
  })).toMatchObject({
    admitted: false,
    className: "activity_state",
  });
  expect(classifyForConversation({
    source: "runtime_turn_event",
    kind: "model.stream.tool_call_delta",
    payload: { toolCallId: "tool-1", rawArgumentsDelta: "{\"path\"" },
  })).toMatchObject({
    admitted: false,
    className: "activity_state",
  });
  expect(classifyForConversation({
    source: "runtime_turn_event",
    kind: "tool.started",
    payload: { toolCallId: "tool-1", safeLabel: "Reading" },
  })).toMatchObject({
    admitted: false,
    className: "activity_state",
  });
  expect(classifyForConversation({
    source: "runtime_turn_event",
    kind: "runtime.future_event",
    payload: { message: { text: "not semantic" } },
  })).toMatchObject({
    admitted: false,
    className: "audit_event",
    reason: "unknown_runtime_event_kind",
  });
});

test("finalized tool results fail closed unless a finalized tool call is known", () => {
  const started = classifyForConversation({
    source: "runtime_turn_event",
    kind: "tool_call.finalized",
    visibility: "internal",
    payload: {
      toolCallId: "tool-1",
      toolName: "Read File",
      safeLabel: "Reading",
    },
  });
  const orphan = classifyForConversation({
    source: "runtime_turn_event",
    kind: "tool_result.finalized",
    visibility: "internal",
    payload: {
      toolCallId: "tool-1",
      toolName: "Read File",
      safeLabel: "Done",
    },
    knownToolCallIds: new Set(),
  });
  const known = classifyForConversation({
    source: "runtime_turn_event",
    kind: "tool_result.finalized",
    visibility: "internal",
    payload: {
      toolCallId: "tool-1",
      toolName: "Read File",
      safeLabel: "Done",
    },
    knownToolCallIds: new Set(["tool-1"]),
  });

  expect(started).toMatchObject({
    admitted: true,
    className: "semantic_tool_call",
    operation: { kind: "append_tool_call", toolCallId: "tool-1" },
  });
  expect(orphan).toMatchObject({
    admitted: false,
    reason: "orphan_tool_result_rejected",
  });
  expect(known).toMatchObject({
    admitted: true,
    className: "semantic_tool_result",
    operation: { kind: "append_tool_result", toolCallId: "tool-1" },
  });
});

test("finalized tool events without internal visibility fail closed", () => {
  expect(classifyForConversation({
    source: "runtime_turn_event",
    kind: "tool_call.finalized",
    payload: {
      toolCallId: "tool-1",
      contentJson: { rawArguments: "{\"secret\":true}" },
    },
  })).toMatchObject({
    admitted: false,
    reason: "finalized_tool_event_not_internal",
  });
});
