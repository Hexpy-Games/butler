import { api } from "./api.ts";
import type { SessionView } from "./types.ts";

/** Publish each bounded activity page immediately; stop when this request is superseded. */
export async function readSessionObserverPages(
  sessionId: string,
  previous: SessionView | undefined,
  isCurrent: () => boolean,
  accept: (view: SessionView) => void,
): Promise<boolean> {
  let messages = previous?.message_window.next_cursor_token;
  let activity = previous?.activity_window?.next_cursor_token;
  do {
    const query = new URLSearchParams({ session_id: sessionId });
    if (messages) query.set("cursor_token", messages);
    if (activity) query.set("activity_cursor_token", activity);
    const data = await api<SessionView>(`/session-view?${query.toString()}`);
    if (!isCurrent()) return false;
    accept(data);
    if (!data.activity_window?.has_more) return true;
    const next = data.activity_window.next_cursor_token;
    if (!next || next === activity) throw new Error("Activity cursor did not advance");
    activity = next;
    messages = data.message_window.next_cursor_token;
  } while (isCurrent());
  return false;
}
