import type { SessionSummary } from "../../../butler-protocol/src/index.ts";

export function sessionMark(s: SessionSummary): "attention" | "working" | "unread" | null {
  if (s.attention_required) return "attention";
  if (s.running_delegated_work || ["queued", "accepted", "thinking", "streaming", "waiting_for_form",
    "waiting_for_tool", "cancelling", "retrying"].includes(s.active_turn_state ?? "")) return "working";
  return s.unread ? "unread" : null;
}

export function timeLabel(iso: string, locale: string, now: Date): string {
  const date = new Date(iso);
  return date.toDateString() === now.toDateString()
    ? date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString(locale, { month: "numeric", day: "numeric" });
}
