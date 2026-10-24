import type { TimelineEvent } from "./types.ts";
const listeners = new Set<(event: TimelineEvent) => void>();
/** Account and fallback signals from the App's existing live-event cursor. */
export function publishChatGptEvent(event: TimelineEvent): void {
  if (event.type !== "setup.chatgpt_account_changed" && event.type !== "agent.turn_event" && event.type !== "agent.turn_event.progress" && event.type !== "provider_quota_updated") return;
  for (const listener of listeners) listener(event);
}
export function onChatGptEvent(listener: (event: TimelineEvent) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
