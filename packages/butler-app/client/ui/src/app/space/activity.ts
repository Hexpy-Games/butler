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
  return attention.has(state)
    ? "attention"
    : active.has(state)
      ? "working"
      : null;
}
