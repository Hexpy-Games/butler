import type { ProgressRow } from "@/app/types";

/** The browser page shown above a turn's activity, or null when the turn has none to show. */
export function browserTimelineStill(activities: Array<{ operations: ProgressRow[]; turnId?: string }>, turnId: string | undefined, live: boolean) {
  const activity = [...activities].reverse().find(item => item.operations.some(row => row.safe_tool_name === "browser_act" && row.tool_result_id));
  const row = [...(activity?.operations ?? [])].reverse().find(item => item.safe_tool_name === "browser_act" && item.tool_result_id);
  const turn = activity?.turnId ?? turnId;
  if (!row?.tool_call_id || !row.tool_result_id || !turn || live && activity === activities.at(-1)) return null;
  // A later capture is the turn's picture and the reply shows it; do not repeat the page above it.
  const rows = activity?.operations ?? [];
  if (rows.slice(rows.indexOf(row) + 1).some(item => item.safe_tool_name === "browser_screenshot" && item.tool_result_id)) return null;
  return { turnId: turn, callId: row.tool_call_id, resultId: row.tool_result_id };
}
