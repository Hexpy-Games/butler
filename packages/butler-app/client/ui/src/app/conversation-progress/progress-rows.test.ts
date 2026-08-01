/// <reference types="bun" />

import { expect, test } from "bun:test";
import type { ProgressRow } from "../types.ts";
import { projectTurnActivity } from "./activity.ts";
import { summaryProgressRows } from "./progress-rows.ts";

test("summary progress keeps only the latest model-authored semantic state", () => {
  const rows: ProgressRow[] = [
    {
      id: "model-wait",
      kind: "message",
      state: "running",
      safe_label: "모델 응답을 기다리고 있습니다",
      bridge_phase: "model_round_waiting",
    },
    {
      id: "admitted",
      kind: "message",
      state: "running",
      safe_label: "요청을 확인하고 있습니다",
      bridge_phase: "admitted",
    },
    {
      id: "conception",
      kind: "message",
      state: "running",
      safe_label: "요청의 의도와 범위를 정리했습니다",
      work_decision_source: "model-authored",
      work_decision_summary: "요청의 의도와 범위를 정리했습니다",
      work_decision_rationale: "정확한 결과 범위를 정하기 위해서입니다",
      work_decision_next_step: "실행 계획을 작성합니다",
    },
    {
      id: "plan",
      kind: "message",
      state: "running",
      safe_label: "배포 범위와 순서를 확정했습니다",
      work_decision_source: "model-authored",
      work_decision_summary: "배포 범위와 순서를 확정했습니다",
      work_decision_rationale: "계획 검토를 통과했습니다",
      work_decision_next_step: "첫 작업을 실행합니다",
    },
  ];

  expect(summaryProgressRows(rows).map((row) => row.id)).toEqual(["plan"]);
});

test("repeated execution activities own only their following tools", () => {
  const activity = (id: string, label: string): ProgressRow => ({
    id,
    kind: "message",
    state: "running",
    safe_label: label,
    semantic_block_id: "task_execution",
    work_decision_source: "model-authored",
    work_decision_summary: label,
    work_decision_rationale: "검증 이유",
    work_decision_next_step: "다음 작업",
  });
  const tool = (id: string): ProgressRow => ({
    id,
    kind: "used_tool",
    state: "delivered",
    safe_label: id,
    semantic_block_id: "task_execution",
    bridge_phase: "btcc_operation",
    safe_tool_name: "run_command",
  });

  const projected = projectTurnActivity([
    activity("activity-a", "첫 실행"),
    tool("tool-a"),
    activity("activity-b", "두 번째 실행"),
    tool("tool-b"),
  ]);

  expect(projected.phaseActivities.map((item) => item.operations.map(({ id }) => id)))
    .toEqual([["tool-a"], ["tool-b"]]);
});

test("activity grouping identity stays separate from its optional display stage and detail", () => {
  const projected = projectTurnActivity([
    {
      id: "plan-activity",
      kind: "message",
      state: "running",
      safe_label: "요청한 결과를 만들 계획입니다.",
      semantic_block_id: "guided-activity:opaque-id",
      activity_stage: "planning",
      work_decision_source: "model-authored",
      work_decision_summary: "요청한 결과를 만들 계획입니다.",
    },
    {
      id: "plan-tool",
      kind: "used_tool",
      state: "delivered",
      safe_label: "작업 계획",
      safe_tool_name: "replace_work_plan",
      tool_call_id: "plan-call",
      semantic_block_id: "guided-activity:opaque-id",
      bridge_phase: "btcc_operation",
    },
  ]);

  expect(projected.phaseActivities).toEqual([
    expect.objectContaining({
      id: "plan-activity",
      phase: "planning",
      summary: "요청한 결과를 만들 계획입니다.",
      rationale: undefined,
      nextStep: undefined,
      operations: [expect.objectContaining({ id: "plan-tool" })],
    }),
  ]);
  expect(projected.semanticState).toBe("planning");
});

test("summary progress prefers the canonical current task list", () => {
  const rows: ProgressRow[] = [
    {
      id: "generic-todo",
      kind: "todo",
      state: "running",
      safe_label: "요청을 확인하고 있습니다",
    },
    {
      id: "task-b",
      kind: "todo",
      state: "pending",
      safe_label: "두 번째 작업",
      safe_input_label: "T-B",
      safe_order: 2,
      bridge_phase: "btcc_work_ledger",
    },
    {
      id: "task-a",
      kind: "todo",
      state: "running",
      safe_label: "첫 번째 작업",
      safe_input_label: "T-A",
      safe_order: 1,
      bridge_phase: "btcc_work_ledger",
    },
  ];

  expect(summaryProgressRows(rows).map((row) => row.id)).toEqual([
    "task-a",
    "task-b",
  ]);
});
