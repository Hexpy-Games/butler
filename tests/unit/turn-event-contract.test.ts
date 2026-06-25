import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import {
  TURN_EVENT_COMPATIBILITY_MAPPINGS,
  FIRST_VISIBLE_PROGRESS_EVENT_KIND,
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

test("turn event contract accepts every public event kind with monotonic sequences", () => {
  for (const [index, kind] of TURN_EVENT_KINDS.entries()) {
    const event = createAgentTurnEvent({
      sessionId: "general",
      turnId: "turn-1",
      sessionSequence: index + 1,
      turnSequence: index + 1,
      kind,
      payload: { safeLabel: "Working" },
    });

    expect(event.kind).toBe(kind);
    expect(event.visibility).toBe("public");
    expect(event.sessionSequence).toBe(index + 1);
    expect(event.turnSequence).toBe(index + 1);
  }
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

test("first visible progress event is public prose without tool or todo dependencies", () => {
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
    kind: "message",
    state: "running",
    safe_label: "관련 매핑을 확인하겠습니다.",
    work_block_label: "관련 매핑을 확인하겠습니다.",
  });
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
  expect(unsafeRow?.work_decision_summary).toBe("safe fallback");
  expect(unsafeRow?.work_decision_rationale).toBeUndefined();
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
