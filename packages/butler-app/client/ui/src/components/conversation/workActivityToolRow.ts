import type { ProgressRow } from "@/app/types.ts";

const WORK_BOOKKEEPING_TOOL_NAMES = new Set([
  "start_work",
  "continue_work",
  "replace_work_plan",
  "record_work_checkpoint",
  "record_work_review",
  "record_work_disposition",
  "plan_review",
  "completion_review",
  "work_tool",
  "tool_work",
]);

/** A row the activity timeline lists as a tool (work bookkeeping stays out). */
export function isWorkActivityToolRow(row: ProgressRow): boolean {
  return !(
    ["work", "work_block", "plan", "checkpoint", "disposition"].includes(row.kind?.toLowerCase() ?? "") ||
    (row.safe_tool_name && WORK_BOOKKEEPING_TOOL_NAMES.has(row.safe_tool_name))
  );
}
