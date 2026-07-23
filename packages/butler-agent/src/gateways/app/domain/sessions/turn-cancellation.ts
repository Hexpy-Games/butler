import { Database } from "bun:sqlite";
import { AppStoreOperationError } from
  "../../infrastructure/core/app-store-errors.ts";
import type { TurnRow } from "../../infrastructure/core/records.ts";
import type {
  MessageRecord,
  TurnActionResult,
  TurnRecord,
} from "../../interface/protocol/app-protocol.ts";

export type TurnCancellationInput = {
  db: Database;
  getTurn: (turnId: string) => TurnRecord;
  getTurnRow: (turnId: string) => TurnRow | null;
  cancelResponder: (turnId: string) => boolean;
  finalizeCancelledTurn: (chatId: string, turnId: string) => TurnRecord;
  cleanupTurnEventSequences: (chatId: string, turnId: string) => void;
  ensureCancelledTurnActivityMessage: (
    chatId: string,
    turnId: string,
  ) => MessageRecord | null;
};

export class AppTurnCancellation {
  constructor(private readonly input: TurnCancellationInput) {}

  async request(turnId: string): Promise<TurnActionResult> {
    const row = this.requireCancellableTurn(turnId);
    if (row.state === "cancelled") {
      this.input.ensureCancelledTurnActivityMessage(row.chat_id, turnId);
      return emptyResult(this.input.getTurn(turnId));
    }

    this.recordDecision(row);
    if (!this.input.cancelResponder(turnId)) {
      return emptyResult(this.input.getTurn(turnId));
    }

    this.completeDirectResponder(turnId);
    const cancelled = this.input.finalizeCancelledTurn(row.chat_id, turnId);
    this.input.cleanupTurnEventSequences(row.chat_id, turnId);
    return emptyResult(cancelled);
  }

  reconcile(sessionId?: string): void {
    const rows = this.input.db
      .query<{ id: string; chat_id: string }, [string | null, string | null]>(`
        SELECT turns.id, turns.chat_id
        FROM turns
        JOIN app_turn_cancel_outbox
          ON app_turn_cancel_outbox.turn_id = turns.id
        WHERE turns.state = 'cancelling'
          AND app_turn_cancel_outbox.state = 'completed'
          AND (? IS NULL OR turns.chat_id = ?)
        ORDER BY turns.rowid ASC
      `)
      .all(sessionId ?? null, sessionId ?? null);
    for (const row of rows) {
      this.input.finalizeCancelledTurn(row.chat_id, row.id);
      this.input.cleanupTurnEventSequences(row.chat_id, row.id);
    }
  }

  private requireCancellableTurn(turnId: string): TurnRow {
    const row = this.input.getTurnRow(turnId);
    if (!row) {
      throw new AppStoreOperationError(404, "turn_not_found", "Turn not found.");
    }
    const resuming = row.state === "cancelling";
    if (
      row.state !== "cancelled" &&
      ((!row.cancellable && !resuming) ||
        ["delivered", "failed"].includes(row.state))
    ) {
      throw new AppStoreOperationError(
        409,
        "turn_not_cancellable",
        "Turn is not cancellable.",
      );
    }
    return row;
  }

  private recordDecision(row: TurnRow): void {
    const now = new Date().toISOString();
    this.input.db.transaction(() => {
      const decision = this.input.db.query(`
        UPDATE turns
        SET state = 'cancelling', safe_status_label = 'Stopping',
          safe_error_code = NULL, retryable = 0, cancellable = 0, updated_at = ?
        WHERE id = ?
          AND state NOT IN ('cancelled', 'delivered', 'failed', 'runtime_fault')
      `).run(now, row.id);
      if (decision.changes !== 1) {
        throw new AppStoreOperationError(
          409,
          "turn_not_cancellable",
          "Turn is not cancellable.",
        );
      }
      this.input.db.query(`
        INSERT INTO app_turn_cancel_outbox (
          turn_id, queue_id, dispatch_claim_id, state, created_at
        ) VALUES (?, NULL, NULL, 'pending', ?)
        ON CONFLICT(turn_id) DO NOTHING
      `).run(row.id, now);
    })();
  }

  private completeDirectResponder(turnId: string): void {
    const now = new Date().toISOString();
    this.input.db.query(`
      UPDATE app_turn_cancel_outbox
      SET state = 'completed', accepted_at = ?, completed_at = ?
      WHERE turn_id = ? AND state = 'pending'
    `).run(now, now, turnId);
  }
}

function emptyResult(turn: TurnRecord): TurnActionResult {
  return { turn, replies: [], next_cursor: 0 };
}
