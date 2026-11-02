import type { ProgressRow, SessionView } from "./types.ts";
import { mergeMessages } from "./utils.ts";

/** A forward-cursor response appends to the loaded window; a snapshot replaces it. */
export function mergeSessionViewWindow(
  previous: SessionView | undefined,
  incoming: SessionView,
): SessionView {
  const window = incoming.message_window;
  if (!previous || previous.session_id !== incoming.session_id ||
    (window.requested_cursor === undefined && !window.requested_cursor_token &&
      !incoming.activity_window?.requested_cursor_token)) {
    return withActivityProgress(incoming);
  }
  const messages = mergeMessages(previous.messages, incoming.messages);
  const history = new Map(
    previous.activity_history?.map((entry) => [entry.turn_id, entry]),
  );
  for (const entry of incoming.activity_history ?? []) {
    const previousEntry = history.get(entry.turn_id);
    history.set(entry.turn_id, { ...entry,
      created_at: previousEntry?.created_at ?? entry.created_at,
      rows: mergeActivityRows(previousEntry?.rows ?? [], entry.rows) });
  }
  return withActivityProgress({
    ...incoming,
    messages,
    ...(history.size ? { activity_history: [...history.values()] } : {}),
    message_window: {
      ...window,
      previous_cursor: messages[0]?.cursor,
      previous_cursor_token: previous.message_window.previous_cursor_token,
    },
  });
}

/** A page may split a turn; stable event ids retain every row exactly once. */
export function mergeActivityRows(previous: ProgressRow[], incoming: ProgressRow[]): ProgressRow[] {
  const rows = new Map(previous.map(row => [row.id, row]));
  for (const row of incoming) rows.set(row.id, row);
  return [...rows.values()].sort((a, b) => (a.turn_event_sequence ?? 0) - (b.turn_event_sequence ?? 0));
}

function withActivityProgress(view: SessionView): SessionView {
  const completeTurn = (turn: SessionView["latest_turn"]) => {
    if (!turn?.progress) return turn;
    const source = view.activity_history?.find(entry => entry.turn_id === turn.id);
    if (!source) return turn;
    return { ...turn, progress: { ...turn.progress,
      safe_progress_rows: mergeActivityRows(source.rows, turn.progress.safe_progress_rows ?? []) } };
  };
  return { ...view, latest_turn: completeTurn(view.latest_turn), active_turn: completeTurn(view.active_turn) };
}
