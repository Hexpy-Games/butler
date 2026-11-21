import type { ConversationMessage, SessionView } from "../../../butler-protocol/src/index.ts";
import type { LiveEvent } from "../../../butler-protocol/src/client/index.ts";

export function applyLiveEvent(view: SessionView, event: LiveEvent): SessionView | "refetch" | null {
  const payload = event.payload;
  if (!payload) return null;
  if (payload.session_id === view.session_id && (event.type.startsWith("question.")
    || event.type.startsWith("authority.") || event.type === "pending_asks.changed")) return "refetch";
  const message = payload.message as ConversationMessage | undefined;
  if ((event.type === "message.created" || event.type === "message.updated") && message?.chat_id === view.session_id) {
    return { ...view, messages: mergeMessages(view.messages, [message]) };
  }
  if (event.type === "message.deleted" && payload.chat_id === view.session_id) {
    return { ...view, messages: view.messages.filter(m => m.id !== payload.message_id) };
  }
  const turn = payload.turn as { chat_id?: string } | undefined;
  const id = payload.chat_id ?? payload.session_id ?? turn?.chat_id ?? message?.chat_id;
  if ((id === view.session_id || view.steward_children?.some(child => child.session_id === id)) && (["turn.", "session_queue.", "session.", "progress."]
    .some(prefix => event.type.startsWith(prefix)) || event.type === "agent.turn_event" || event.type === "agent.turn_event.progress")) {
    return "refetch";
  }
  return null;
}

export function mergeMessages(previous: ConversationMessage[], incoming: ConversationMessage[]): ConversationMessage[] {
  const messages = new Map(previous.map(message => [message.id, message]));
  for (const message of incoming) {
    const old = messages.get(message.id);
    if (old?.updated_at && message.updated_at && message.updated_at < old.updated_at) continue;
    messages.set(message.id, message);
  }
  return [...messages.values()].sort((a, b) => {
    if (a.cursor !== undefined && b.cursor !== undefined) return a.cursor - b.cursor;
    if (a.created_at && b.created_at) return a.created_at.localeCompare(b.created_at);
    if (a.cursor === undefined && !a.created_at) return b.cursor === undefined && !b.created_at ? 0 : 1;
    if (b.cursor === undefined && !b.created_at) return -1;
    return 0;
  });
}
