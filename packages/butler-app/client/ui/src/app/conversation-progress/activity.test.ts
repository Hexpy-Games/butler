/// <reference types="bun" />

import { expect, test } from "bun:test";
import { projectTurnActivity } from "./activity";
import type { ProgressRow } from "../types";

test("unbound ordinary operations project to one stable 작업 중 activity", () => {
  const rows: ProgressRow[] = [
    operationRow({
      id: "operation-1",
      toolCallId: "tool-1",
      label: "첫 번째 작업",
      sequence: 1,
    }),
    operationRow({
      id: "operation-1-replay",
      toolCallId: "tool-1",
      label: "첫 번째 작업 재전송",
      sequence: 2,
    }),
    operationRow({
      id: "operation-2",
      toolCallId: "tool-2",
      label: "두 번째 작업",
      sequence: 3,
    }),
    operationRow({
      id: "operation-2",
      toolCallId: "tool-2-replay-with-new-call-id",
      label: "두 번째 작업 재전송",
      sequence: 4,
    }),
  ];

  const first = projectTurnActivity(rows, "turn-unbound");
  const replay = projectTurnActivity([...rows, ...rows], "turn-unbound");

  expect(first.phaseActivities).toHaveLength(1);
  expect(first.phaseActivities[0]?.title).toBe("작업 중");
  expect(first.phaseActivities[0]?.phase).toBeUndefined();
  expect(first.workBlocks).toHaveLength(0);
  expect(first.phaseActivities[0]?.id).toBe("turn-unbound-ordinary");
  expect(first.phaseActivities[0]?.operations.map((row) => row.id)).toEqual([
    "operation-1",
    "operation-2",
  ]);
  expect(replay.phaseActivities[0]?.id).toBe(first.phaseActivities[0]?.id);
  expect(replay.phaseActivities[0]?.operations.map((row) => row.id)).toEqual([
    "operation-1",
    "operation-2",
  ]);
});

test("an anchored model-authored activity is not replaced by the fallback", () => {
  const projected = projectTurnActivity([
    {
      id: "anchored",
      kind: "message",
      state: "completed",
      safe_label: "구상 내용을 확인했습니다.",
      semantic_block_id: "conception",
      work_decision_title: "구상 확인",
      work_decision_summary: "구상 내용을 확인했습니다.",
      work_decision_source: "model-authored",
      activity_stage: "conception",
    },
    operationRow({
      id: "operation-1",
      toolCallId: "tool-1",
      label: "구상 도구",
      sequence: 1,
      semanticBlockId: "conception",
    }),
  ]);

  expect(projected.phaseActivities).toHaveLength(1);
  expect(projected.phaseActivities[0]?.title).toBe("구상 확인");
  expect(projected.phaseActivities[0]?.operations.map((row) => row.id)).toEqual([
    "operation-1",
  ]);
});

test("turns without ordinary operation rows do not invent an activity", () => {
  expect(projectTurnActivity([
    {
      id: "assistant-message",
      kind: "message",
      state: "completed",
      safe_label: "답변을 전달했습니다.",
    },
  ]).phaseActivities).toHaveLength(0);
});

test("Work-owned operation rows do not receive the unbound fallback", () => {
  expect(projectTurnActivity([
    {
      ...operationRow({
        id: "work-operation",
        toolCallId: "tool-work",
        label: "Work 도구",
        sequence: 1,
      }),
      work_block_id: "work-owned",
    },
  ]).phaseActivities).toHaveLength(0);
});

test("fallback scopes operation rows to the resolved current Turn", () => {
  const projected = projectTurnActivity([
    {
      ...operationRow({
        id: "operation-current",
        toolCallId: "tool-current",
        label: "현재 턴",
        sequence: 1,
        semanticBlockId: "",
      }),
      turn_id: "turn-current",
    },
    {
      ...operationRow({
        id: "operation-other",
        toolCallId: "tool-other",
        label: "다른 턴",
        sequence: 2,
        semanticBlockId: "",
      }),
      turn_id: "turn-other",
    },
  ], "turn-current");
  expect(projected.phaseActivities[0]?.id).toBe("turn:turn-current:ordinary");
  expect(projected.phaseActivities[0]?.operations.map((row) => row.id)).toEqual([
    "operation-current",
  ]);
});

test("operation rows without a resolvable Turn identity do not invent a fallback", () => {
  expect(projectTurnActivity([
    operationRow({
      id: "operation-without-turn",
      toolCallId: "tool-without-turn",
      label: "턴 없는 도구",
      sequence: 1,
    }),
  ]).phaseActivities).toHaveLength(0);
});

function operationRow(input: {
  id: string;
  toolCallId: string;
  label: string;
  sequence: number;
  semanticBlockId?: string;
}): ProgressRow {
  return {
    id: input.id,
    kind: "ran_command",
    state: "completed",
    safe_label: input.label,
    safe_tool_name: "Bun",
    safe_input_label: input.label,
    tool_call_id: input.toolCallId,
    bridge_phase: "btcc_operation",
    semantic_block_id: input.semanticBlockId ?? "turn-unbound-ordinary",
    turn_event_sequence: input.sequence,
  };
}
