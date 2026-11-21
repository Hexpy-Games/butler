// test-category: pure-logic
import { expect, test } from "bun:test";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import type { ProgressSummaryRow, SessionViewTurn } from "../../../butler-protocol/src/index.ts";
import { turnStatusLabel } from "./workStatus";
import { projectActivities } from "./activityProjection";

test("projectActivities keeps only localized model-authored activities", () => {
  const rows: ProgressSummaryRow[] = [
    { id: "model", kind: "turn", safe_label: "openai/gpt-6-sol", state: "running", created_at: "2026-11-20T00:00:00Z" },
    { id: "wait", kind: "turn", safe_label: "Generating", interface_label_key: "generating", bridge_phase: "model_round_waiting", state: "running", created_at: "2026-11-20T00:00:00Z" },
    { id: "plan", kind: "used_tool", safe_label: "replace_work_plan", safe_tool_name: "replace_work_plan", bridge_phase: "btcc_operation", state: "delivered", created_at: "2026-11-20T00:00:00Z" },
    { id: "activity", kind: "message", safe_label: "Work complete", state: "delivered", semantic_block_id: "report", activity_stage: "reporting",
      work_decision_source: "model-authored", work_decision_title: "Work complete", work_decision_summary: "Finished the work",
      interface_content: { title: { key: "toolTitle", parameters: { toolName: "record_work_disposition" } } }, created_at: "2026-11-20T00:00:00Z" },
    { id: "completed", kind: "turn", safe_label: "Completed", state: "completed", created_at: "2026-11-20T00:00:00Z" },
  ];
  expect(projectActivities(rows, undefined, "ko-KR").activities.map(({ title, summary, phase }) => ({ title, summary, phase }))).toEqual([
    { title: getAppCopy("ko-KR").guided.tools.record_work_disposition, summary: "Finished the work", phase: "reporting" },
  ]);
});

test("turnStatusLabel localizes a model-round wait instead of Thinking", () => {
  const turn: SessionViewTurn = {
    id: "turn", state: "thinking", safe_status_label: "Thinking", cancellable: true, retryable: false,
    created_at: "2026-11-20T00:00:00Z", updated_at: "2026-11-20T00:00:00Z",
    progress: { safe_progress_rows: [
      { id: "model", kind: "turn", safe_label: "openai/gpt-6-sol", state: "running", created_at: "2026-11-20T00:00:00Z" },
      { id: "wait", kind: "turn", safe_label: "Generating", interface_label_key: "generating", bridge_phase: "model_round_waiting", state: "running", created_at: "2026-11-20T00:00:00Z" },
    ] },
  };
  expect(turnStatusLabel(turn, "ko-KR")).toBe(getAppCopy("ko-KR").interfaceStatus.generating);
});
