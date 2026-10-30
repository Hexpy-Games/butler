import type { SessionSummary } from "../types";
const active = new Set([
  "queued",
  "accepted",
  "thinking",
  "streaming",
  "waiting_for_tool",
  "cancelling",
  "retrying",
  "session_starting",
]);
const attention = new Set(["waiting_for_form", "runtime_fault", "failed"]);
/**
 * `nested`: the row shows its subtasks beneath it, so attention that only a
 * subtask raised rests on that subtask's line and the parent shows work.
 */
export function spaceActivity(
  session?: SessionSummary,
  nested = false,
): "working" | "attention" | null {
  const state = session?.active_turn_state ?? "";
  const delegatedOnly = nested && session?.attention_source === "subtask";
  if ((session?.attention_required && !delegatedOnly) || state === "waiting_for_form") return "attention";
  if (session?.running_delegated_work || delegatedOnly) return "working";
  return attention.has(state) ? "attention" : active.has(state) ? "working" : null;
}
