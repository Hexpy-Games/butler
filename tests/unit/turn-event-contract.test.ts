import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import {
  TURN_EVENT_COMPATIBILITY_MAPPINGS,
  FIRST_VISIBLE_PROGRESS_EVENT_KIND,
  type ModelStreamReasoningDeltaPayload,
  type ModelStreamTextDeltaPayload,
  type ModelStreamToolCallDeltaPayload,
  type ProviderStreamEventKind,
  TURN_EVENT_KINDS,
  createAgentTurnEvent,
  progressRowFromTurnEvent,
  sanitizePublicText,
  turnEventFromProgressRow,
} from "../../packages/butler-agent/src/agent/events/turn-events.ts";
import {
  FIRST_VISIBLE_PROGRESS_ACCEPTED_SAFETY_STATUS,
  FIRST_VISIBLE_PROGRESS_DEFAULT_SOURCE,
  FIRST_VISIBLE_PROGRESS_FALLBACK_NOTE,
  firstVisibleProgressPayload,
} from "../../packages/butler-agent/src/agent/events/first-visible-progress.ts";
import {
  TURN_COMPLETION_EVIDENCE_EVENT_KIND,
  TURN_DECISION_EVENT_KIND,
  TURN_ACKNOWLEDGED_EVENT_KIND,
  createTurnAcknowledgedPayload,
  createTurnDecisionPayload,
} from "../../packages/butler-agent/src/agent/events/turn-state-contract.ts";

test("turn event contract accepts every public event kind with monotonic sequences", () => {
  for (const [index, kind] of TURN_EVENT_KINDS.entries()) {
    const event = createAgentTurnEvent({
      sessionId: "general",
      turnId: "turn-1",
      sessionSequence: index + 1,
      turnSequence: index + 1,
      kind,
      visibility: visibilityForEventKind(kind),
      payload: payloadForEventKind(kind),
    });

    expect(event.kind).toBe(kind);
    expect(event.visibility).toBe(visibilityForEventKind(kind));
    expect(event.sessionSequence).toBe(index + 1);
    expect(event.turnSequence).toBe(index + 1);
    expect(JSON.stringify(event)).not.toContain("operatorSummary");
  }
});

test("turn event kind registry has no duplicate values", () => {
  expect(new Set(TURN_EVENT_KINDS).size).toBe(TURN_EVENT_KINDS.length);
});

function visibilityForEventKind(kind: string): "public" | "internal" {
  if (kind === "model.stream.reasoning_delta") return "internal";
  if (kind === "model.stream.tool_call_delta") return "internal";
  return "public";
}

function payloadForEventKind(kind: string): Record<string, unknown> {
  if (kind === TURN_DECISION_EVENT_KIND) {
    return {
      decisionId: "decision-1",
      role: "tool_intent",
      summary: "Checking the turn contract.",
      rationale: "The fixture needs an authored public decision record.",
      nextStep: "Use the decision before visible work.",
      source: "assistant-authored",
    };
  }
  if (kind === TURN_COMPLETION_EVIDENCE_EVENT_KIND) {
    return {
      evidenceKind: "command_executed",
      status: "verified",
      summary: "A command execution receipt was verified for this fixture.",
      refs: ["receipt:test-command"],
    };
  }
  if (kind === "turn.outcome") {
    return {
      outcome: "completed",
      completionEvidenceRefs: ["evidence-1"],
      publicSummary: "Completed with evidence.",
    };
  }
  if (kind === "runtime.fault") {
    return {
      faultId: "fault-1",
      turnId: "turn-1",
      kind: "provider_stream_corruption",
      retryable: true,
      publicSummary: "Runtime stream was interrupted.",
      operatorSummary: "Provider stream emitted an invalid tool result frame.",
      createdAt: "2026-06-28T00:00:00.000Z",
    };
  }
  if (kind === "recovery.recorded") {
    return {
      recoveryToken: "recovery-1",
      reason: "Interrupted before completion.",
    };
  }
  if (kind === "diagnostic.invariant_violation") {
    return {
      invariant: "fixture",
      summary: "Fixture diagnostic.",
    };
  }
  if (kind === "model.stream.text_delta") {
    return {
      streamId: "stream-1",
      textDelta: "Opening draft",
      target: "opening_decision",
      sequence: 1,
    };
  }
  if (kind === "model.stream.reasoning_delta") {
    return {
      streamId: "stream-1",
      charCount: 42,
      sequence: 1,
    };
  }
  if (kind === "model.stream.tool_call_delta") {
    return {
      streamId: "stream-1",
      callIndex: 0,
      sequence: 1,
      toolCallId: "tool-call-1",
      safeToolName: "Read file",
      argumentCharCount: 12,
      publicState: "generating",
    };
  }
  if (kind === "model.stream.completed") {
    return {
      streamId: "stream-1",
      status: "completed",
    };
  }
  return { safeLabel: "Working" };
}

test("provider stream event kinds and payloads are explicit contract members", () => {
  const textPayload: ModelStreamTextDeltaPayload = {
    streamId: "stream-opening-1",
    textDelta: "Public draft text",
    target: "opening_decision",
    sequence: 1,
  };
  const reasoningPayload: ModelStreamReasoningDeltaPayload = {
    streamId: "stream-opening-1",
    charCount: 128,
    sequence: 2,
  };
  const toolCallPayload: ModelStreamToolCallDeltaPayload = {
    streamId: "stream-opening-1",
    callIndex: 0,
    sequence: 3,
    toolCallId: "tool-call-1",
    safeToolName: "Read file",
    argumentCharCount: 7,
    rawArgumentsDelta: "{\"path\":\"/Users/example/private/raw-payload.json\",\"query\":\"<think>keep raw</think>\"",
    publicState: "generating",
  };
  const fixtures: Array<{
    kind: ProviderStreamEventKind;
    visibility: "public" | "internal";
    payload: unknown;
  }> = [
    { kind: "model.stream.text_delta", visibility: "public", payload: textPayload },
    { kind: "model.stream.reasoning_delta", visibility: "internal", payload: reasoningPayload },
    { kind: "model.stream.tool_call_delta", visibility: "internal", payload: toolCallPayload },
    {
      kind: "model.stream.completed",
      visibility: "internal",
      payload: { streamId: "stream-opening-1", status: "completed" },
    },
  ];

  for (const [index, fixture] of fixtures.entries()) {
    if (!isRecordPayload(fixture.payload)) {
      throw new Error("provider stream fixture payload must be a record");
    }
    const event = createAgentTurnEvent({
      sessionId: "general",
      turnId: "turn-1",
      sessionSequence: index + 1,
      turnSequence: index + 1,
      kind: fixture.kind,
      visibility: fixture.visibility,
      payload: fixture.payload,
    });
    expect(event.kind).toBe(fixture.kind);
    expect(event.payload.streamId).toBe(fixture.payload.streamId);
    if ("textDelta" in fixture.payload) {
      expect(event.payload.textDelta).toBe(fixture.payload.textDelta);
    }
    if ("charCount" in fixture.payload) {
      expect(event.payload.charCount).toBe(fixture.payload.charCount);
      expect(event.payload).not.toHaveProperty("delta");
    }
    if ("rawArgumentsDelta" in fixture.payload) {
      expect(event.payload.rawArgumentsDelta).toBe(fixture.payload.rawArgumentsDelta);
      expect(event.payload.toolCallId).toBe(fixture.payload.toolCallId);
      expect(event.payload.rawArgumentsDelta).toContain("/Users/example/private/raw-payload.json");
      expect(event.payload.rawArgumentsDelta).toContain("<think>keep raw</think>");
    }
  }
});

function isRecordPayload(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

test("public provider stream tool call deltas reject raw argument fragments", () => {
  expect(() => createAgentTurnEvent({
    sessionId: "general",
    turnId: "turn-1",
    sessionSequence: 1,
    turnSequence: 1,
    kind: "model.stream.tool_call_delta",
    visibility: "public",
    payload: {
      streamId: "stream-public-tool-1",
      callIndex: 0,
      sequence: 1,
      safeToolName: "Read file",
      argumentCharCount: 7,
      rawArgumentsDelta: "{\"path\"",
      publicState: "generating",
    },
  })).toThrow("public model stream tool call deltas must not include rawArgumentsDelta");

  const event = createAgentTurnEvent({
    sessionId: "general",
    turnId: "turn-1",
    sessionSequence: 1,
    turnSequence: 2,
    kind: "model.stream.tool_call_delta",
    visibility: "public",
    payload: {
      streamId: "stream-public-tool-1",
      callIndex: 0,
      sequence: 2,
      safeToolName: "Read file",
      argumentCharCount: 7,
      publicState: "ready",
    },
  });

  expect(event.payload).toMatchObject({
    streamId: "stream-public-tool-1",
    safeToolName: "Read file",
    publicState: "ready",
  });
  expect(event.payload).not.toHaveProperty("rawArgumentsDelta");
});

test("public payload counter-like keys stay textual outside provider stream events", () => {
  const event = createAgentTurnEvent({
    sessionId: "general",
    turnId: "turn-1",
    sessionSequence: 1,
    turnSequence: 1,
    kind: "assistant.public_note",
    visibility: "public",
    payload: {
      note: "Working through a sequence.",
      sequence: "1",
      charCount: "many",
      callIndex: "first",
      argumentCharCount: "hidden",
    },
  });

  expect(event.payload.sequence).toBe("1");
  expect(event.payload.charCount).toBe("many");
  expect(event.payload.callIndex).toBe("first");
  expect(event.payload.argumentCharCount).toBe("hidden");
});

test("turn event privacy fixtures keep public labels and suppress private protocol text", () => {
  const positive = [
    "Reading project ledger",
    "Running tests",
    "Response checked",
    "Dispatching reviewer",
    "Final answer ready",
  ];
  const negative = [
    "<think>private chain</think>",
    "< thinking /> let me think through the private path",
    "<|channel|>analysis",
    "hidden reasoning: inspect raw transcript",
    '{"sessionId":"butler/app-general","payload":{"tool_call":true}}',
    "FileNotFoundException own tool output artifact root_path = /tmp/butler-workers/task/result.md not found",
    "Inspect /Users/example/private/raw-payload.json before answering",
    "Inspect /Users/홍길동/private/raw-payload.json before answering",
    "Inspect C:\\Users\\alice\\private\\raw-payload.json before answering",
    "Inspect \\\\server\\share\\private\\raw-payload.json before answering",
    Buffer.from("<thinking>private chain</thinking>", "utf8").toString("base64"),
  ];
  const secrets = [
    "api_key=sk-private",
    "Authorization: Bearer private-token",
    "DATABASE_URL=postgres://user:pass@localhost/db",
  ];

  for (const text of positive) {
    expect(sanitizePublicText(text, "fallback")).toBe(text);
  }
  for (const text of negative) {
    expect(sanitizePublicText(text, "fallback")).toBe("fallback");
  }
  for (const text of secrets) {
    const sanitized = sanitizePublicText(text, "fallback");
    expect(sanitized).toContain("[redacted]");
    expect(sanitized).not.toContain("private-token");
    expect(sanitized).not.toContain("sk-private");
    expect(sanitized).not.toContain("postgres://");
  }
});

test("turn acknowledged event projects a deterministic accepted row", () => {
  const event = createAgentTurnEvent({
    sessionId: "general",
    turnId: "turn-1",
    sessionSequence: 1,
    turnSequence: 1,
    kind: TURN_ACKNOWLEDGED_EVENT_KIND,
    payload: createTurnAcknowledgedPayload({
      safeLabel: "Request received. Preparing the work.",
      transport: "app",
    }),
  });

  expect(progressRowFromTurnEvent(event)).toMatchObject({
    id: event.id,
    kind: "turn",
    state: "accepted",
    safe_label: "Request received. Preparing the work.",
    receipt_kind: TURN_ACKNOWLEDGED_EVENT_KIND,
  });
});

test("assistant decision event projects as a dedicated public decision row", () => {
  const event = createAgentTurnEvent({
    sessionId: "general",
    turnId: "turn-1",
    sessionSequence: 1,
    turnSequence: 2,
    kind: TURN_DECISION_EVENT_KIND,
    payload: createTurnDecisionPayload({
      decisionId: "opening-decision-1",
      role: "opening",
      source: "model-authored",
      firstVisible: true,
      summary: "I will inspect the active read model.",
      rationale: "Opening decisions must survive reload as typed rows.",
      nextStep: "Render this decision before work blocks.",
      modelCallId: "model-call-opening-1",
      latencyMs: 37,
      evidenceRefs: [TURN_ACKNOWLEDGED_EVENT_KIND],
    }),
  });

  expect(progressRowFromTurnEvent(event)).toMatchObject({
    id: event.id,
    kind: "decision",
    state: "running",
    safe_label: "I will inspect the active read model.",
    public_decision_role: "opening",
    public_decision_summary: "I will inspect the active read model.",
    public_decision_rationale:
      "Opening decisions must survive reload as typed rows.",
    public_decision_next_step: "Render this decision before work blocks.",
    public_decision_source: "model-authored",
    public_decision_model_call_id: "model-call-opening-1",
    public_decision_latency_ms: 37,
    public_decision_evidence_refs: [TURN_ACKNOWLEDGED_EVENT_KIND],
  });
  expect(progressRowFromTurnEvent(event)?.work_block_id).toBeUndefined();
  expect(progressRowFromTurnEvent(event)?.work_block_label).toBeUndefined();
  expect(progressRowFromTurnEvent(event)?.safe_tool_name).toBeUndefined();
  expect(progressRowFromTurnEvent(event)?.work_decision_summary).toBeUndefined();
});

test("turn event progress projection preserves safe tool activity", () => {
  const event = createAgentTurnEvent({
    sessionId: "general",
    turnId: "turn-1",
    sessionSequence: 1,
    turnSequence: 1,
    kind: "tool.started",
    payload: {
      toolCallId: "tool-1",
      workBlockId: "work-tool-1",
      workBlockLabel: "Checking local Project Ledger status",
      activityKind: "ran_command",
      toolName: "Bash",
      inputLabel: "bun test",
      safeLabel: "Bash: bun test",
      bridgePhase: "invoke",
    },
  });

  expect(progressRowFromTurnEvent(event)).toMatchObject({
    id: event.id,
    kind: "ran_command",
    state: "running",
    safe_tool_name: "Bash",
    safe_input_label: "bun test",
    tool_call_id: "tool-1",
    bridge_phase: "invoke",
    work_block_id: "work-tool-1",
    work_block_label: "Checking local Project Ledger status",
  });
});

test("first visible progress event projects as legacy turn status only", () => {
  const event = createAgentTurnEvent({
    sessionId: "general",
    turnId: "turn-1",
    sessionSequence: 1,
    turnSequence: 1,
    kind: FIRST_VISIBLE_PROGRESS_EVENT_KIND,
    payload: firstVisibleProgressPayload({
      note: "관련 매핑을 확인하겠습니다.",
      source: FIRST_VISIBLE_PROGRESS_DEFAULT_SOURCE,
      safetyStatus: FIRST_VISIBLE_PROGRESS_ACCEPTED_SAFETY_STATUS,
    }),
  });

  expect(event.kind).toBe(FIRST_VISIBLE_PROGRESS_EVENT_KIND);
  expect(event.payload).toMatchObject({
    note: "관련 매핑을 확인하겠습니다.",
    source: FIRST_VISIBLE_PROGRESS_DEFAULT_SOURCE,
    safetyStatus: FIRST_VISIBLE_PROGRESS_ACCEPTED_SAFETY_STATUS,
    workBlockLabel: "관련 매핑을 확인하겠습니다.",
  });
  expect(event.payload.toolCallId).toBeUndefined();
  expect(event.payload.activityKind).toBeUndefined();

  expect(progressRowFromTurnEvent(event)).toMatchObject({
    id: event.id,
    kind: "turn",
    state: "thinking",
    safe_label: "관련 매핑을 확인하겠습니다.",
  });
  expect(progressRowFromTurnEvent(event)?.work_block_id).toBeUndefined();
  expect(progressRowFromTurnEvent(event)?.work_block_label).toBeUndefined();
  expect(progressRowFromTurnEvent(event)?.work_decision_summary).toBeUndefined();
});

test("first visible progress policy repairs unsafe or evidence-claiming notes", () => {
  const unsafePrivate = firstVisibleProgressPayload({
    note: "<think>private chain</think>",
    source: FIRST_VISIBLE_PROGRESS_DEFAULT_SOURCE,
  });
  expect(unsafePrivate.note).toBe(FIRST_VISIBLE_PROGRESS_FALLBACK_NOTE);
  expect(JSON.stringify(unsafePrivate)).not.toContain("private chain");

  const unsupportedEvidenceClaim = firstVisibleProgressPayload({
    note: "파일을 이미 확인했고 결과를 검증했습니다.",
    source: FIRST_VISIBLE_PROGRESS_DEFAULT_SOURCE,
  });
  expect(unsupportedEvidenceClaim.note).toBe(FIRST_VISIBLE_PROGRESS_FALLBACK_NOTE);
});

test("work block events project safe process block metadata", () => {
  const event = createAgentTurnEvent({
    sessionId: "general",
    turnId: "turn-1",
    sessionSequence: 1,
    turnSequence: 1,
    kind: "work.block.started",
    payload: {
      workBlockId: "work-tool-1",
      label: "Checking local Project Ledger status",
    },
  });

  expect(progressRowFromTurnEvent(event)).toMatchObject({
    kind: "work_block",
    state: "running",
    safe_label: "Checking local Project Ledger status",
    work_block_id: "work-tool-1",
    work_block_label: "Checking local Project Ledger status",
  });
});

test("work block events project public decision context without private reasoning", () => {
  const event = createAgentTurnEvent({
    sessionId: "general",
    turnId: "turn-1",
    sessionSequence: 1,
    turnSequence: 1,
    kind: "work.block.started",
    payload: {
      workBlockId: "work-decision-1",
      label: "Checking official event data before transforming it.",
      decisionRole: "tool_intent",
      decisionSummary: "Checking official event data before transforming it.",
      decisionRationale: "This keeps the report grounded in accessible public sources.",
      decisionNextStep: "Use the verified rows as the CSV input for the local transform.",
      decisionEvidenceRefs: ["city events source"],
      decisionSource: "assistant-authored",
    },
  });

  expect(progressRowFromTurnEvent(event)).toMatchObject({
    kind: "work_block",
    work_block_id: "work-decision-1",
    work_decision_summary: "Checking official event data before transforming it.",
    work_decision_rationale: "This keeps the report grounded in accessible public sources.",
    work_decision_next_step: "Use the verified rows as the CSV input for the local transform.",
    work_decision_source: "assistant-authored",
    work_decision_evidence_refs: ["city events source"],
  });

  const unsafe = createAgentTurnEvent({
    sessionId: "general",
    turnId: "turn-1",
    sessionSequence: 1,
    turnSequence: 2,
    kind: "work.block.started",
    payload: {
      workBlockId: "work-unsafe",
      label: "safe fallback",
      decisionSummary: "<think>private chain</think>",
      decisionRationale: "{\"sessionId\":\"private\",\"payload\":{\"tool_call\":true}}",
    },
  });
  const unsafeRow = progressRowFromTurnEvent(unsafe);
  expect(JSON.stringify(unsafeRow)).not.toContain("private chain");
  expect(JSON.stringify(unsafeRow)).not.toContain("sessionId");
  expect(unsafeRow?.work_decision_summary).toBeUndefined();
  expect(unsafeRow?.work_decision_rationale).toBeUndefined();

  const authoredWithoutSummary = createAgentTurnEvent({
    sessionId: "general",
    turnId: "turn-1",
    sessionSequence: 1,
    turnSequence: 3,
    kind: "work.block.started",
    payload: {
      workBlockId: "work-authored-empty",
      label: "This label must stay a work-block label only.",
      decisionRole: "tool_intent",
      decisionSource: "assistant-authored",
    },
  });
  const authoredWithoutSummaryRow = progressRowFromTurnEvent(authoredWithoutSummary);
  expect(authoredWithoutSummaryRow?.work_block_label)
    .toBe("This label must stay a work-block label only.");
  expect(authoredWithoutSummaryRow?.work_decision_summary).toBeUndefined();
  expect(authoredWithoutSummaryRow?.work_decision_source).toBeUndefined();
});

test("runtime-derived and repaired progress payloads do not project public decisions", () => {
  for (const source of ["runtime-derived", "review-repaired", undefined]) {
    const event = createAgentTurnEvent({
      sessionId: "general",
      turnId: "turn-1",
      sessionSequence: 1,
      turnSequence: 1,
      kind: "work.block.started",
      payload: {
        workBlockId: `work-${source ?? "missing"}`,
        label: "Checking local state.",
        decisionSummary: "This must not become a public decision.",
        decisionRationale: "Runtime repair text is diagnostic only.",
        decisionNextStep: "Do not render this as a decision.",
        decisionRole: "tool_intent",
        decisionSource: source,
      },
    });

    expect(progressRowFromTurnEvent(event)).toMatchObject({
      kind: "work_block",
      safe_label: "Checking local state.",
      work_block_label: "Checking local state.",
    });
    expect(progressRowFromTurnEvent(event)?.work_decision_summary).toBeUndefined();
    expect(progressRowFromTurnEvent(event)?.work_decision_source).toBeUndefined();
  }
});

test("legacy progress rows map into public turn events", () => {
  const event = turnEventFromProgressRow({
    sessionId: "general",
    turnId: "turn-1",
    sessionSequence: 1,
    turnSequence: 1,
    row: {
      id: "progress-1",
      kind: "searched",
      safe_label: "Search docs",
      state: "running",
      created_at: new Date(0).toISOString(),
      safe_tool_name: "Web search",
      tool_call_id: "tool-search-1",
      work_block_id: "work-search-1",
      work_block_label: "Checking public forecast sources",
    },
  });

  expect(event.kind).toBe("tool.progress");
  expect(event.payload).toMatchObject({
    activityKind: "searched",
    toolName: "Web search",
    safeLabel: "Search docs",
    toolCallId: "tool-search-1",
    workBlockId: "work-search-1",
    workBlockLabel: "Checking public forecast sources",
  });
});

test("compatibility mappings document replay, progress, and transport projections", () => {
  expect(TURN_EVENT_COMPATIBILITY_MAPPINGS.map((item) => item.source)).toEqual(
    expect.arrayContaining([
      "progress.summary",
      "worker activity summary",
      "typing presence",
      "message.created assistant",
    ]),
  );
});
