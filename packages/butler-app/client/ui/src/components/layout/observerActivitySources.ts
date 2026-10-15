import type { MessageRecord, SessionView } from "@/app/types.ts";

/** Every turn whose activity rows a sub-session view carries, keyed by turn id. */
export function observerActivitySources(
  messages: MessageRecord[],
  activityHistory: NonNullable<SessionView["activity_history"]>,
  activeTurn?: SessionView["active_turn"],
  latestTurn?: SessionView["latest_turn"],
) {
  const sources = new Map<string, { turn_id: string; created_at?: string; rows: NonNullable<MessageRecord["turn_activity_rows"]> }>(
    activityHistory.map((source) => [source.turn_id, source]),
  );
  for (const message of messages) {
    if (message.role === "assistant" && message.turn_id && message.turn_activity_rows?.length) {
      sources.set(message.turn_id, { turn_id: message.turn_id,
        created_at: message.turn_activity_rows.find((row) => row.created_at)?.created_at ?? message.created_at,
        rows: message.turn_activity_rows });
    }
  }
  // Child session messages do not carry turn_activity_rows. The gateway keeps
  // their public record on latest_turn.progress even after active_turn clears.
  if (latestTurn && !sources.has(latestTurn.id)) sources.set(latestTurn.id, {
    turn_id: latestTurn.id, created_at: latestTurn.created_at,
    rows: latestTurn.progress?.safe_progress_rows ?? [],
  });
  if (activeTurn) sources.set(activeTurn.id, { turn_id: activeTurn.id,
    created_at: activeTurn.created_at, rows: activeTurn.progress?.safe_progress_rows ?? [] });
  return sources;
}
