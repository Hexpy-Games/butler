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
export function spaceActivity(
  session?: SessionSummary,
): "working" | "attention" | null {
  const state = session?.active_turn_state ?? "";
  if (session?.attention_required || state === "waiting_for_form") return "attention";
  if (session?.running_delegated_work) return "working";
  return attention.has(state) ? "attention" : active.has(state) ? "working" : null;
}
