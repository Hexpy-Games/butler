import type { SessionViewTurn, TurnProgressSnapshot } from "./types.ts";

/**
 * The gateway may omit `progress` on a turn (for example Steward child turns).
 * Treat that as a snapshot with no safe rows instead of dereferencing undefined.
 */
export function turnProgressOf(
  turn: Pick<SessionViewTurn, "progress" | "state" | "updated_at">,
): TurnProgressSnapshot {
  return turn.progress ?? {
    state: turn.state,
    safe_progress_rows: [],
    updated_at: turn.updated_at,
  };
}
