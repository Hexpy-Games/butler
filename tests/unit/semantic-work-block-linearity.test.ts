import { expect, test } from "bun:test";
import { createAgentTurnEvent, progressRowFromTurnEvent } from "../../packages/butler-agent/src/agent/events/turn-events.ts";
import { SharedProgressReducer } from "../../packages/butler-progress-projection/src/index.ts";
import { normalizeProgressSummaryRow } from "../../packages/butler-agent/src/gateways/app/domain/progress-summary/progress-row-normalizer.ts";
import { dedupeProgressRows } from "../../packages/butler-agent/src/gateways/app/domain/progress-summary/progress-row-merge.ts";
import { publicProgressRowsForTurn } from "../../packages/butler-agent/src/gateways/app/domain/progress-summary/public-progress-rows.ts";
import { workBlocksFromTerminalProgressRows } from "../../packages/butler-agent/src/gateways/app/domain/sessions/session-work-blocks.ts";
import { workBlocksFromProgressRows } from "../../packages/butler-app/client/ui/src/app/utils.ts";

const sharedDecision = {
  decisionSummary: "관련 파일을 확인합니다.",
  decisionRationale: "관찰 결과에 따라 다음 작은 단계를 선택합니다.",
  decisionNextStep: "파일을 읽고 결과를 확인합니다.",
  decisionSource: "assistant-authored",
};

test("typed identifiers survive the public event and progress protocol projection", () => {
  const event = createAgentTurnEvent({
    sessionId: "butler/main",
    turnId: "turn-linear",
    sessionSequence: 1,
    turnSequence: 1,
    kind: "tool.started",
    payload: {
      toolCallId: "tool-a",
      toolName: "Read",
      inputLabel: "a.ts",
      safeLabel: "Read: a.ts",
      activityKind: "read",
      workBlockId: "turn-linear:contract-a:block:1",
      workBlockLabel: "첫 번째 파일을 확인합니다.",
      contractId: "contract-a",
      workstreamId: "workstream-a",
      semanticBlockId: "contract-a:block:1",
      ...sharedDecision,
    },
  });

  const projected = progressRowFromTurnEvent(event);
  expect(projected).toMatchObject({
    work_contract_id: "contract-a",
    work_stream_id: "workstream-a",
    semantic_block_id: "contract-a:block:1",
  });
  expect(normalizeProgressSummaryRow(projected!)).toMatchObject({
    work_contract_id: "contract-a",
    work_stream_id: "workstream-a",
    semantic_block_id: "contract-a:block:1",
  });
});

test("todo identity survives the shared live turn-event projection", () => {
  const event = createAgentTurnEvent({
    sessionId: "butler/main",
    turnId: "turn-todo",
    sessionSequence: 1,
    turnSequence: 2,
    kind: "tool.progress",
    payload: {
      activityKind: "todo",
      inputLabel: "wcap-1",
      safeLabel: "T-WCAP-01 타입 확장 검증 중",
      state: "running",
      safeOrder: 1,
    },
  });

  expect(progressRowFromTurnEvent(event)).toMatchObject({
    kind: "todo",
    safe_input_label: "wcap-1",
    safe_label: "T-WCAP-01 타입 확장 검증 중",
    state: "running",
    safe_order: 1,
  });
});

test("same-label todos with different stable ids remain distinct", () => {
  const rows = [
    normalizeProgressSummaryRow({
      id: "todo-a",
      kind: "todo",
      state: "accepted",
      safe_label: "동일한 표시 이름",
      safe_input_label: "todo-a",
      safe_order: 1,
    }),
    normalizeProgressSummaryRow({
      id: "todo-b",
      kind: "todo",
      state: "accepted",
      safe_label: "동일한 표시 이름",
      safe_input_label: "todo-b",
      safe_order: 2,
    }),
  ];

  expect(dedupeProgressRows(rows).map((row) => row.safe_input_label)).toEqual([
    "todo-a",
    "todo-b",
  ]);
});

test("server todo projection preserves the established ordinal on completion", () => {
  const rows = [
    normalizeProgressSummaryRow({
      id: "todo-running",
      kind: "todo",
      state: "running",
      safe_label: "첫 단계 진행 중",
      safe_input_label: "first",
      safe_order: 1,
    }),
    normalizeProgressSummaryRow({
      id: "todo-completed",
      kind: "todo",
      state: "delivered",
      safe_label: "첫 단계",
      safe_input_label: "first",
      safe_order: 4,
    }),
  ];

  expect(dedupeProgressRows(rows)).toEqual([
    expect.objectContaining({
      safe_input_label: "first",
      safe_order: 1,
      state: "delivered",
    }),
  ]);
});

test("block title and decision content survive as distinct replay fields", () => {
  const event = createAgentTurnEvent({
    sessionId: "butler/main",
    turnId: "turn-title",
    sessionSequence: 1,
    turnSequence: 7,
    kind: "work.block.started",
    payload: {
      workBlockId: "turn-title:contract-a:block:1",
      label: "폴더 구조 확인",
      decisionId: "decision-a",
      decisionTitle: "폴더 구조 확인",
      decisionSummary: "src의 컴포넌트 구성을 파악하기 위해 먼저 폴더 구조를 확인합니다.",
      decisionRationale: "읽을 파일의 범위를 작은 단위로 정하기 위해서입니다.",
      decisionNextStep: "확인된 폴더에서 첫 세 파일을 읽습니다.",
      decisionSource: "assistant-authored",
      contractId: "contract-a",
      semanticBlockId: "contract-a:block:1",
    },
  });

  expect(progressRowFromTurnEvent(event)).toMatchObject({
    turn_event_sequence: 7,
    work_block_phase: "started",
    work_block_sequence: 1,
    work_decision_id: "decision-a",
    work_decision_title: "폴더 구조 확인",
    work_decision_summary:
      "src의 컴포넌트 구성을 파악하기 위해 먼저 폴더 구조를 확인합니다.",
  });
});

test("public replay keeps semantic block carriers and drops only first-visible placeholders", () => {
  const rows = [
    normalizeProgressSummaryRow({
      id: "first-visible",
      kind: "work_block",
      safe_label: "Preparing",
      state: "running",
      work_block_id: "first-progress-preparing",
      work_block_label: "Preparing",
    }),
    normalizeProgressSummaryRow({
      id: "semantic-block",
      kind: "work_block",
      safe_label: "폴더 구조 확인",
      state: "running",
      work_block_id: "turn-a:contract-a:block:1",
      work_block_label: "폴더 구조 확인",
      work_block_phase: "started",
    }),
  ];

  expect(publicProgressRowsForTurn(rows, null).map((row) => row.id)).toEqual([
    "semantic-block",
  ]);
  expect(publicProgressRowsForTurn(rows.slice(0, 1), null).map((row) => row.id)).toEqual([
    "first-visible",
  ]);
});

test("completed semantic blocks stay immutable when a later decision repeats the same text", () => {
  const rows = [
    blockRow("block-1-start", "work-1", "contract-a:block:1", "running"),
    toolRow("tool-1", "work-1", "contract-a:block:1", "delivered"),
    blockRow("block-1-complete", "work-1", "contract-a:block:1", "delivered"),
    blockRow("block-2-start", "work-2", "contract-a:block:2", "running"),
    toolRow("tool-2", "work-2", "contract-a:block:2", "running"),
  ].map(normalizeProgressSummaryRow);

  const deduped = dedupeProgressRows(rows);
  const serverBlocks = workBlocksFromTerminalProgressRows(deduped);
  expect(serverBlocks.map((block) => ({ id: block.id, state: block.state }))).toEqual([
    { id: "work-1", state: "delivered" },
    { id: "work-2", state: "running" },
  ]);
  expect(serverBlocks[0]?.rows.map((row) => row.tool_call_id)).toEqual(["tool-1"]);
  expect(serverBlocks[1]?.rows.map((row) => row.tool_call_id)).toEqual(["tool-2"]);

  const appBlocks = workBlocksFromProgressRows(deduped);
  expect(appBlocks.map((block) => ({ id: block.id, state: block.state }))).toEqual([
    { id: "work-1", state: "delivered" },
    { id: "work-2", state: "running" },
  ]);
  expect(appBlocks[0]?.rows.map((row) => row.tool_call_id)).toEqual(["tool-1"]);
  expect(appBlocks[1]?.rows.map((row) => row.tool_call_id)).toEqual(["tool-2"]);
});

test("late tools are quarantined instead of mutating a closed block", () => {
  const reducer = new SharedProgressReducer();
  reducer.append(normalizeProgressSummaryRow({
    ...blockRow("block-start", "work-1", "contract-a:block:1", "running"),
    work_block_phase: "started",
    work_decision_title: "첫 파일 묶음 확인",
  }));
  reducer.append(normalizeProgressSummaryRow({
    ...blockRow("block-update", "work-1", "contract-a:block:1", "running"),
    work_block_phase: "updated",
    work_decision_title: "과거 제목을 바꾸면 안 됩니다",
    work_decision_summary: "과거 결정도 바꾸면 안 됩니다.",
  }));
  expect(reducer.snapshot().blocks[0]).toMatchObject({
    label: "첫 파일 묶음 확인",
    decision_title: "첫 파일 묶음 확인",
    decision_summary: sharedDecision.decisionSummary,
  });
  reducer.append(normalizeProgressSummaryRow(toolRow(
    "tool-1",
    "work-1",
    "contract-a:block:1",
    "delivered",
  )));
  reducer.append(normalizeProgressSummaryRow({
    ...blockRow("block-complete", "work-1", "contract-a:block:1", "delivered"),
    work_block_phase: "completed",
  }));
  const closedBlock = JSON.stringify(reducer.snapshot().blocks[0]);

  reducer.append(normalizeProgressSummaryRow(toolRow(
    "tool-late",
    "work-1",
    "contract-a:block:1",
    "delivered",
  )));

  expect(JSON.stringify(reducer.snapshot().blocks[0])).toBe(closedBlock);
  expect(reducer.snapshot().issues).toEqual([
    {
      code: "tool_for_closed_block",
      rowId: "tool-late",
      workBlockId: "work-1",
    },
  ]);
});

test("an explicit new block cannot implicitly close or replace the current block", () => {
  const reducer = new SharedProgressReducer();
  reducer.append(normalizeProgressSummaryRow({
    ...blockRow("block-1-start", "work-1", "contract-a:block:1", "running"),
    work_block_phase: "started",
    work_block_sequence: 1,
    work_decision_id: "decision-1",
  }));
  const original = JSON.stringify(reducer.snapshot().blocks[0]);

  reducer.append(normalizeProgressSummaryRow({
    ...blockRow("block-2-start", "work-2", "contract-a:block:2", "running"),
    work_block_phase: "started",
    work_block_sequence: 2,
    work_decision_id: "decision-2",
  }));
  reducer.append(normalizeProgressSummaryRow({
    ...toolRow("tool-2", "work-2", "contract-a:block:2", "running"),
    work_block_sequence: 2,
    work_decision_id: "decision-2",
  }));

  expect(reducer.snapshot().blocks).toHaveLength(1);
  expect(JSON.stringify(reducer.snapshot().blocks[0])).toBe(original);
  expect(reducer.snapshot().issues).toEqual([
    {
      code: "new_block_before_previous_closed",
      rowId: "block-2-start",
      workBlockId: "work-2",
    },
    {
      code: "tool_for_unknown_block",
      rowId: "tool-2",
      workBlockId: "work-2",
    },
  ]);
});

test("live events and refreshed persisted rows produce identical work blocks", () => {
  const events = [
    turnEvent("block-1-start", 1, "work.block.started", {
      workBlockId: "work-1",
      label: "첫 파일 묶음 확인",
      decisionId: "decision-1",
      decisionTitle: "첫 파일 묶음 확인",
      ...sharedDecision,
      contractId: "contract-a",
      semanticBlockId: "contract-a:block:1",
    }),
    turnEvent("tool-1-start", 2, "tool.started", {
      toolCallId: "tool-1",
      toolName: "Read",
      inputLabel: "a.ts",
      safeLabel: "Read: a.ts",
      activityKind: "read",
      workBlockId: "work-1",
      workBlockLabel: "첫 파일 묶음 확인",
      decisionId: "decision-1",
      decisionTitle: "첫 파일 묶음 확인",
      ...sharedDecision,
      contractId: "contract-a",
      semanticBlockId: "contract-a:block:1",
    }),
    turnEvent("tool-1-complete", 3, "tool.completed", {
      toolCallId: "tool-1",
      toolName: "Read",
      inputLabel: "a.ts",
      safeLabel: "Read: a.ts",
      activityKind: "read",
      workBlockId: "work-1",
      workBlockLabel: "첫 파일 묶음 확인",
      decisionId: "decision-1",
      decisionTitle: "첫 파일 묶음 확인",
      ...sharedDecision,
      contractId: "contract-a",
      semanticBlockId: "contract-a:block:1",
    }),
    turnEvent("block-1-complete", 4, "work.block.completed", {
      workBlockId: "work-1",
      label: "첫 파일 묶음 확인",
      status: "completed",
      decisionId: "decision-1",
      decisionTitle: "첫 파일 묶음 확인",
      ...sharedDecision,
      contractId: "contract-a",
      semanticBlockId: "contract-a:block:1",
    }),
    turnEvent("block-2-start", 5, "work.block.started", {
      workBlockId: "work-2",
      label: "다음 파일 묶음 확인",
      decisionId: "decision-2",
      decisionTitle: "다음 파일 묶음 확인",
      ...sharedDecision,
      contractId: "contract-a",
      semanticBlockId: "contract-a:block:2",
    }),
  ];
  const liveRows = events
    .map(progressRowFromTurnEvent)
    .filter((row): row is NonNullable<typeof row> => Boolean(row));
  const replayRows = publicProgressRowsForTurn(
    liveRows.map(normalizeProgressSummaryRow),
    null,
  );

  expect(workBlocksFromProgressRows(liveRows)).toEqual(
    workBlocksFromTerminalProgressRows(replayRows),
  );
  expect(workBlocksFromProgressRows(liveRows).map((block) => block.label)).toEqual([
    "첫 파일 묶음 확인",
    "다음 파일 묶음 확인",
  ]);
});

function blockRow(id: string, workBlockId: string, semanticBlockId: string, state: string) {
  return {
    id,
    kind: "work_block",
    safe_label: "관련 파일을 확인합니다.",
    state,
    work_block_id: workBlockId,
    work_block_label: "관련 파일을 확인합니다.",
    work_contract_id: "contract-a",
    work_stream_id: "workstream-a",
    semantic_block_id: semanticBlockId,
    work_decision_summary: sharedDecision.decisionSummary,
    work_decision_rationale: sharedDecision.decisionRationale,
    work_decision_next_step: sharedDecision.decisionNextStep,
    work_decision_source: sharedDecision.decisionSource,
  };
}

function toolRow(id: string, workBlockId: string, semanticBlockId: string, state: string) {
  return {
    id,
    kind: "read",
    safe_label: "Read: a.ts",
    state,
    safe_tool_name: "Read",
    safe_input_label: "a.ts",
    tool_call_id: id,
    work_block_id: workBlockId,
    work_block_label: "관련 파일을 확인합니다.",
    work_contract_id: "contract-a",
    work_stream_id: "workstream-a",
    semantic_block_id: semanticBlockId,
    work_decision_summary: sharedDecision.decisionSummary,
    work_decision_rationale: sharedDecision.decisionRationale,
    work_decision_next_step: sharedDecision.decisionNextStep,
    work_decision_source: sharedDecision.decisionSource,
  };
}

function turnEvent(
  id: string,
  turnSequence: number,
  kind: Parameters<typeof createAgentTurnEvent>[0]["kind"],
  payload: Record<string, unknown>,
) {
  return createAgentTurnEvent({
    id,
    sessionId: "butler/main",
    turnId: "turn-replay",
    sessionSequence: turnSequence,
    turnSequence,
    kind,
    payload,
  });
}
