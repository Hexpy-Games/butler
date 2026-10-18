import type { ProgressRow } from "@/app/types";

/** Stub progress and answers for ActivityLayoutHarness. */
export const defaultRows: ProgressRow[] = [{
  id: "activity-layout-read", kind: "message", state: "delivered",
  semantic_block_id: "activity-layout-step", work_decision_source: "model-authored",
  work_decision_summary: "활동 화면 확인", safe_label: "활동 화면 확인",
  created_at: "2026-10-03T00:00:01.000Z",
}, {
  id: "files-start", kind: "work_block", state: "running", safe_label: "파일 확인",
  work_block_id: "files", work_block_label: "파일 확인", work_block_phase: "started",
  created_at: "2026-10-03T00:00:01.050Z",
}, {
  id: "listing", kind: "searched", state: "delivered", safe_label: "파일 목록 확인",
  safe_tool_name: "list_files", safe_input_label: "C:\\Users\\test\\Downloads", tool_call_id: "listing-call",
  work_block_id: "files", semantic_block_id: "activity-layout-step", bridge_phase: "btcc_operation",
  created_at: "2026-10-03T00:00:01.100Z",
}, {
  id: "reading", kind: "read", state: "delivered", safe_label: "파일 읽기",
  safe_tool_name: "read_file", safe_input_label: "보고서.txt", tool_call_id: "reading-call",
  work_block_id: "files", semantic_block_id: "activity-layout-step", bridge_phase: "btcc_operation",
  interface_content: { title: { key: "toolTitle", parameters: { toolName: "read_file", target: "보고서.txt" } } },
  created_at: "2026-10-03T00:00:01.200Z",
}, {
  id: "files-end", kind: "work_block", state: "delivered", safe_label: "파일 확인",
  work_block_id: "files", work_block_label: "파일 확인", work_block_phase: "completed",
  created_at: "2026-10-03T00:00:01.250Z",
}];
export const roundTwoRows: ProgressRow[] = [{
  id: "activity-layout-summary", kind: "message", state: "delivered",
  semantic_block_id: "activity-layout-summary-step", work_decision_source: "model-authored",
  work_decision_summary: "결과 정리", safe_label: "결과 정리",
  created_at: "2026-10-03T00:00:03.000Z",
}];
export const noRows: ProgressRow[] = [];
export const answer = "확인한 활동을 답변과 함께 표시합니다.\n\n".repeat(8);
export const roundOne = "첫 라운드 중간 답변입니다.\n\n".repeat(6);
export const decisionRows: ProgressRow[] = [{
  id: "activity-layout-decision", kind: "decision", state: "delivered", safe_label: "다음 단계 결정",
  public_decision_source: "model-authored", public_decision_summary: "파일 목록부터 확인합니다",
  created_at: "2026-10-03T00:00:01.000Z",
}];
export const segmentOne = "질문 전에 확인한 내용입니다.\n\n".repeat(3);
