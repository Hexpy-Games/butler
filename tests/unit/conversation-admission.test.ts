import { expect, test } from "bun:test";
import {
  classifyForConversation,
  TRANSCRIPT_TOP_LEVEL_EVENT_KINDS,
} from "../../packages/butler-agent/src/agent/conversation/admission.ts";

const SAFE_ARGUMENTS = {
  schema_version: "butler.tool-call-arguments-transcript.v1",
  argument_keys: ["path"],
  safe_arguments: { path: "README.md" },
};

const MALICIOUS_ARGUMENTS = {
  schema_version: "butler.tool-call-arguments-transcript.v1",
  argument_keys: ["path", "token", "rawArguments"],
  safe_arguments: {
    path: "README.md",
    token: "SECRET_TOKEN_123",
    rawArguments: "{\"token\":\"SECRET_TOKEN_123\"}",
  },
};

const MALICIOUS_RESULT = {
  schema_version: "butler.tool-result-evidence-transcript.v1",
  evidence_capability_receipts: [{
    rawArguments: "{\"token\":\"SECRET_TOKEN_123\"}",
    summary: "SECRET_TOKEN_123",
  }],
  evidence_receipts: [{
    kind: "command",
    token: "SECRET_TOKEN_123",
  }],
  evidence_limitations: ["SECRET_TOKEN_123"],
  completion_obligation_evidence: {
    outcome: "satisfied",
    token: "SECRET_TOKEN_123",
    limitations: ["SECRET_TOKEN_123"],
  },
};

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

test("finalized tool semantic content ignores arbitrary contentJson", () => {
  const decision = classifyForConversation({
    source: "runtime_turn_event",
    kind: "tool_call.finalized",
    visibility: "internal",
    payload: {
      toolCallId: "tool-1",
      toolName: "read_file",
      arguments: MALICIOUS_ARGUMENTS,
      contentJson: {
        name: "SECRET_TOKEN_123",
        rawArguments: "{\"token\":\"SECRET_TOKEN_123\"}",
        arguments: {
          schema_version: "butler.tool-call-arguments-transcript.v1",
          argument_keys: ["token"],
          safe_arguments: { token: "SECRET_TOKEN_123" },
        },
      },
    },
  });

  expect(decision).toMatchObject({
    admitted: true,
    className: "semantic_tool_call",
    operation: {
      kind: "append_tool_call",
      contentJson: {
        eventKind: "tool_call.finalized",
        toolCallId: "tool-1",
        safeToolName: "read_file",
        arguments: SAFE_ARGUMENTS,
      },
    },
  });
  expect(JSON.stringify(decision.operation)).not.toContain("SECRET_TOKEN_123");
  expect(JSON.stringify(decision.operation)).not.toContain("rawArguments");
});

test("finalized tool result evidence is sanitized before semantic admission", () => {
  const decision = classifyForConversation({
    source: "runtime_turn_event",
    kind: "tool_result.finalized",
    visibility: "internal",
    payload: {
      toolCallId: "tool-1",
      toolName: "read_file",
      ok: true,
      result: MALICIOUS_RESULT,
      safeError: "SECRET_TOKEN_123",
      safeObservation: {
        observationId: "obs-1",
        kind: "validation_failed",
        visibility: "model",
        summary: "SECRET_TOKEN_123",
        modelVisibleContent: "SECRET_TOKEN_123",
        rawArguments: "{\"token\":\"SECRET_TOKEN_123\"}",
      },
    },
    knownToolCallIds: new Set(["tool-1"]),
  });

  expect(decision).toMatchObject({
    admitted: true,
    className: "semantic_tool_result",
    operation: {
      kind: "append_tool_result",
      contentJson: {
        eventKind: "tool_result.finalized",
        toolCallId: "tool-1",
        safeToolName: "read_file",
        ok: true,
      },
    },
  });
  expect(JSON.stringify(decision.operation)).not.toContain("SECRET_TOKEN_123");
  expect(JSON.stringify(decision.operation)).not.toContain("rawArguments");
});
