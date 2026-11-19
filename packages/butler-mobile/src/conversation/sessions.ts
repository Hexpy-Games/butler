import type { NavigationView, SessionSummary } from "../../../butler-protocol/src/index.ts";

export type Section = { key: string; title: string; data: SessionSummary[] };

export function conversationSections(view: NavigationView, generalTitle: string): Section[] {
  const sessions = (items: SessionSummary[]) => items.filter(s => !s.archived)
    .sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at));
  const general = { key: "general", title: generalTitle, data: sessions(view.chats) };
  const projects = view.projects.filter(p => !p.archived)
    .map(p => ({ key: p.id, title: p.display_name, data: sessions(p.sessions ?? []) }))
    .filter(p => p.data.length > 0)
    .sort((a, b) => b.data[0].last_activity_at.localeCompare(a.data[0].last_activity_at));
  return [general, ...projects].filter(section => section.data.length > 0);
}

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
