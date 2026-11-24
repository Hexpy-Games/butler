import type { SessionViewTurn, TurnProgressSnapshot } from "./types.ts";
import { isActiveTurnProgressSnapshot, isClientTurnId } from "./utils.ts";

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

/**
 * Only a session's latest turn can be running. Drops non-final progress of any
 * other server turn; pending client turns and final snapshots are kept.
 */
export function pruneStaleServerTurnProgress(
  turnProgress: Record<string, TurnProgressSnapshot>,
  latestTurnId: string | undefined,
): Record<string, TurnProgressSnapshot> {
  let next: Record<string, TurnProgressSnapshot> | null = null;
  for (const [turnId, snapshot] of Object.entries(turnProgress)) {
    if (turnId === latestTurnId || isClientTurnId(turnId)) continue;
    if (!isActiveTurnProgressSnapshot(snapshot)) continue;
    next ??= { ...turnProgress };
    delete next[turnId];
  }
  return next ?? turnProgress;
}
