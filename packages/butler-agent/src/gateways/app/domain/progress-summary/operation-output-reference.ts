import type { ProgressSummaryRow } from
  "../../interface/protocol/app-protocol.ts";

export function operationOutputIsLinked(
  rows: readonly ProgressSummaryRow[],
  requestId: string,
  resultId: string,
): boolean {
  return rows.some(
    (row) =>
      row.bridge_phase === "btcc_operation" &&
      row.tool_call_id === requestId &&
      row.tool_result_id === resultId,
  );
}
