// test-category: pure-logic
import { expect, test } from "bun:test";
import type { ProgressSummaryRow } from "../../../butler-protocol/src/index.ts";
import { liveTurnWork } from "./activityProjection";

const decision: ProgressSummaryRow = {
  id: "decision", kind: "decision", safe_label: "Check the result", state: "delivered",
  created_at: "2026-11-24T00:00:00Z", public_decision_source: "model-authored",
  public_decision_summary: "Check the result",
};

test("liveTurnWork projects a live work block", () => {
  const rows: ProgressSummaryRow[] = [{
    id: "work", kind: "work_block", safe_label: "Review", state: "running",
    created_at: "2026-11-24T00:00:00Z", work_block_id: "review", work_block_label: "Review",
    work_block_phase: "started",
  }];
  expect(liveTurnWork(rows, "en-US").blocks.length).toBe(1);
});

test("liveTurnWork shows a lone model-authored decision", () => {
  expect(liveTurnWork([decision], "en-US").decision?.summary).toBe("Check the result");
});

test("liveTurnWork hides the decision during a running operation", () => {
  const operation: ProgressSummaryRow = {
    id: "operation", kind: "used_tool", safe_label: "Read", state: "running",
    created_at: "2026-11-24T00:00:01Z", bridge_phase: "btcc_operation", work_block_id: "review",
  };
  expect(liveTurnWork([decision, operation], "en-US").decision).toBeUndefined();
});
