import { expect, test } from "bun:test";
import {
  progressRowsForTurnState,
  publicProgressRowsForTurn,
} from "../../packages/butler-agent/src/gateways/app/domain/progress-summary/public-progress-rows.ts";
import type { ProgressSummaryRow } from "../../packages/butler-agent/src/gateways/app/interface/protocol/app-protocol.ts";

const CREATED_AT = "2026-07-04T08:10:00.000Z";

test("public progress rows replace first visible preparation with semantic work", () => {
  const rows: ProgressSummaryRow[] = [
    {
      id: "turn-first-progress",
      kind: "turn",
      state: "thinking",
      safe_label: "요청의 범위와 다음 작업 경로를 먼저 정리하겠습니다.",
      created_at: CREATED_AT,
      work_block_id: "first-progress-note",
      work_block_label: "요청의 범위와 다음 작업 경로를 먼저 정리하겠습니다.",
    },
    {
      id: "first-work-block",
      kind: "work_block",
      state: "running",
      safe_label: "요청의 범위와 다음 작업 경로를 먼저 정리하겠습니다.",
      created_at: CREATED_AT,
      work_block_id: "first-progress-note",
      work_block_label: "요청의 범위와 다음 작업 경로를 먼저 정리하겠습니다.",
    },
    {
      id: "ordinary-work-block",
      kind: "work_block",
      state: "running",
      safe_label: "Checking files",
      created_at: CREATED_AT,
      work_block_id: "work-file-check",
      work_block_label: "Checking files",
    },
  ];

  expect(publicProgressRowsForTurn(rows, "thinking")).toEqual([
    {
      id: "ordinary-work-block",
      kind: "work_block",
      state: "running",
      safe_label: "Checking files",
      created_at: CREATED_AT,
      work_block_id: "work-file-check",
      work_block_label: "Checking files",
    },
  ]);
});

test("public progress rows drop first visible preparation block after terminal delivery", () => {
  const rows: ProgressSummaryRow[] = [
    {
      id: "first-work-block",
      kind: "work_block",
      state: "running",
      safe_label: "요청의 범위와 다음 작업 경로를 먼저 정리하겠습니다.",
      created_at: CREATED_AT,
      work_block_id: "first-progress-note",
      work_block_label: "요청의 범위와 다음 작업 경로를 먼저 정리하겠습니다.",
    },
    {
      id: "real-message",
      kind: "message",
      state: "running",
      safe_label: "검증 결과를 정리 중",
      created_at: CREATED_AT,
      work_block_id: "work-report",
      work_block_label: "검증 결과를 정리 중",
    },
  ];

  expect(
    progressRowsForTurnState(publicProgressRowsForTurn(rows, "delivered"), "delivered"),
  ).toEqual([
    {
      id: "real-message",
      kind: "message",
      state: "delivered",
      safe_label: "검증 결과를 정리 중",
      created_at: CREATED_AT,
      work_block_id: "work-report",
      work_block_label: "검증 결과를 정리 중",
    },
  ]);
});

test("terminal turns preserve canonical BTCC Work Ledger rows", () => {
  const rows: ProgressSummaryRow[] = [
    {
      id: "accepted-task",
      kind: "todo",
      state: "completed",
      safe_label: "Accepted Task",
      bridge_phase: "btcc_work_ledger",
      created_at: CREATED_AT,
    },
    {
      id: "future-task",
      kind: "todo",
      state: "planned",
      safe_label: "Future Task",
      bridge_phase: "btcc_work_ledger",
      created_at: CREATED_AT,
      safe_detail_rows: [{
        id: "work",
        kind: "work",
        safe_label: "Work",
        safe_value: "Future Work",
        state: "planned",
      }],
    },
  ];

  expect(progressRowsForTurnState(rows, "delivered")).toEqual(rows);
  expect(progressRowsForTurnState(rows, "cancelled")).toEqual(rows);
});

test("legacy terminal progress retains existing folding behavior", () => {
  const row: ProgressSummaryRow = {
    id: "legacy-task",
    kind: "todo",
    state: "active",
    safe_label: "Legacy Task",
    created_at: CREATED_AT,
  };

  expect(progressRowsForTurnState([row], "delivered")[0]?.state).toBe("delivered");
  expect(progressRowsForTurnState([row], "cancelled")[0]?.state).toBe("cancelled");
});
