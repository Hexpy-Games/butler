import type { Database } from "bun:sqlite";
import type {
  ConversationProjectionEvent,
  ConversationProjectionReader,
  ConversationTurnLifecycleProjection,
} from "../../../../agent/conversation/types.ts";
import type { TurnState } from "../../interface/protocol/app-protocol.ts";

interface AppLifecycleState {
  state: TurnState;
  safeStatusLabel: string;
  safeErrorCode: string | null;
  retryable: boolean;
  cancellable: boolean;
}

const APP_TERMINAL_STATES = new Set<TurnState>([
  "cancelled",
  "delivered",
  "failed",
  "runtime_fault",
]);

export class AppConversationLifecycleProjector {
  constructor(
    private readonly input: {
      db: Database;
      reader: ConversationProjectionReader;
    },
  ) {}

  project(event: ConversationProjectionEvent): string | null {
    if (!this.input.reader.readTurnLifecycleProjection) {
      throw new Error("conversation_lifecycle_reader_unavailable");
    }
    const snapshot = this.input.reader.readTurnLifecycleProjection(
      event.conversation_session_id,
      event.seq,
    );
    if (!snapshot) throw new Error(`conversation_turn_lifecycle_missing:${event.outbox_id}`);
    const current = this.input.db.query<{ state: TurnState }, [string]>(`
      SELECT state
      FROM turns
      WHERE id = ?
    `).get(snapshot.turn_id);
    const projected = appLifecycleState(snapshot);
    // Gateway-neutral conversations can be projected into App as semantic
    // messages without an App-owned turn lifecycle row. App-admitted turns
    // create that row before canonical conversation admission, so absence here
    // means there is no local lifecycle entity to reconcile.
    if (!current) return null;
    if (current.state === "cancelling" && projected.state === "cancelled") {
      // The App cancellation owner must freeze public assistant snapshots and
      // settle its control-plane outbox before the turn row becomes terminal.
      return null;
    }
    if (APP_TERMINAL_STATES.has(current.state) && !APP_TERMINAL_STATES.has(projected.state)) {
      return null;
    }
    const changed = this.input.db.query(`
      UPDATE turns
      SET state = ?, safe_status_label = ?, safe_error_code = ?,
        retryable = ?, cancellable = ?, updated_at = ?
      WHERE id = ?
        AND (
          state != ? OR safe_status_label != ? OR
          COALESCE(safe_error_code, '') != COALESCE(?, '') OR
          retryable != ? OR cancellable != ?
        )
    `).run(
      projected.state,
      projected.safeStatusLabel,
      projected.safeErrorCode,
      projected.retryable ? 1 : 0,
      projected.cancellable ? 1 : 0,
      snapshot.updated_at,
      snapshot.turn_id,
      projected.state,
      projected.safeStatusLabel,
      projected.safeErrorCode,
      projected.retryable ? 1 : 0,
      projected.cancellable ? 1 : 0,
    ).changes;
    return changed > 0 ? snapshot.turn_id : null;
  }
}

function appLifecycleState(
  snapshot: ConversationTurnLifecycleProjection,
): AppLifecycleState {
  switch (snapshot.btcc_lifecycle_status) {
    case "waiting_user":
      return state("waiting_for_form", "Waiting for input", null, true);
    case "waiting_external":
      return state("waiting_for_tool", "Waiting for external work", null, true);
    case "waiting_runtime":
      return state(
        "waiting_runtime",
        "Waiting for runtime recovery",
        null,
        true,
      );
    case "cancelled":
      return state("cancelled", "Cancelled", null, false);
    case "delivered":
      return state("delivered", "Delivered", null, false);
  }
  if (snapshot.conversation_status === "aborted") {
    return state("cancelled", "Cancelled", null, false);
  }
  if (snapshot.conversation_status === "complete") {
    return state("delivered", "Delivered", null, false);
  }
  return state("thinking", "Thinking", null, true);
}

function state(
  turnState: TurnState,
  safeStatusLabel: string,
  safeErrorCode: string | null,
  cancellable: boolean,
): AppLifecycleState {
  return {
    state: turnState,
    safeStatusLabel,
    safeErrorCode,
    retryable: false,
    cancellable,
  };
}
