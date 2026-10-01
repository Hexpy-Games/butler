import type { SessionView } from "./types.ts";
import { mergeMessages } from "./utils.ts";

/** A forward-cursor response appends to the loaded window; a snapshot replaces it. */
export function mergeSessionViewWindow(
  previous: SessionView | undefined,
  incoming: SessionView,
): SessionView {
  const window = incoming.message_window;
  if (!previous || previous.session_id !== incoming.session_id ||
    (window.requested_cursor === undefined && !window.requested_cursor_token)) {
    return incoming;
  }
  const messages = mergeMessages(previous.messages, incoming.messages);
  const history = new Map(
    previous.activity_history?.map((entry) => [entry.turn_id, entry]),
  );
  for (const entry of incoming.activity_history ?? []) history.set(entry.turn_id, entry);
  return {
    ...incoming,
    messages,
    ...(history.size ? { activity_history: [...history.values()] } : {}),
    message_window: {
      ...window,
      previous_cursor: messages[0]?.cursor,
      previous_cursor_token: previous.message_window.previous_cursor_token,
    },
  };
}
