import type { ProgressRow } from "@/app/types";
import { BrowserStepStill } from "../browser/BrowserStepStill";
import { WorkerCallCapsule } from "./WorkerCallCapsule";

export function toolchainAfter(row: ProgressRow, rows: ProgressRow[], turnId?: string) {
  if (!turnId || !row.tool_call_id) return {};
  if (row.safe_tool_name === "delegate_to_worker") return { after: <WorkerCallCapsule turnId={turnId} callId={row.tool_call_id} /> };
  const latest = [...rows].reverse().find(item => item.safe_tool_name === "browser_act" && item.tool_result_id);
  if (row === latest && row.tool_result_id) return { after: <BrowserStepStill turnId={turnId} callId={row.tool_call_id} resultId={row.tool_result_id} /> };
  return {};
}
