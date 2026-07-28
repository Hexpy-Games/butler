import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { BtccTurnRuntime } from "../../../agent/btcc/index.ts";

type PendingStopRow = {
  turn_id: string;
  state: string;
};

export class BtccStopRequestReconciler {
  private running: Promise<void> | null = null;

  constructor(
    private readonly dbPath: string,
    private readonly runtime: BtccTurnRuntime,
  ) {}

  reconcile(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.reconcilePendingStops().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  close(): void {}

  private async reconcilePendingStops(): Promise<void> {
    if (!existsSync(this.dbPath)) return;
    const db = new Database(this.dbPath);
    try {
      if (!hasStopProjectionTables(db)) return;
      const rows = db.query<PendingStopRow, []>(`
        SELECT app_turn_cancel_outbox.turn_id, app_turn_cancel_outbox.state
        FROM app_turn_cancel_outbox
        JOIN turns ON turns.id = app_turn_cancel_outbox.turn_id
        WHERE turns.state = 'cancelling'
          AND app_turn_cancel_outbox.state IN ('pending', 'accepted')
        ORDER BY app_turn_cancel_outbox.created_at
      `).all();
      for (const row of rows) {
        const outcome = await this.runtime.stopTurn({ kind: "stop", turnId: row.turn_id });
        if (outcome.kind === "fenced_pending_persistence") continue;
        this.commitProjection(db, row.turn_id, outcome.kind);
      }
    } finally {
      db.close();
    }
  }

  private commitProjection(db: Database, turnId: string, outcome: string): void {
    const transaction = db.transaction(() => {
      const now = new Date().toISOString();
      db.query(`
        UPDATE app_turn_cancel_outbox
        SET state = 'completed', accepted_at = COALESCE(accepted_at, ?),
          completed_at = ?, safe_error_code = NULL
        WHERE turn_id = ? AND state IN ('pending', 'accepted')
      `).run(now, now, turnId);
      if (outcome === "cancelled" || outcome === "already_cancelled") {
        db.query(`
          UPDATE turns
          SET state = 'cancelled', safe_status_label = 'Cancelled',
            safe_error_code = NULL, retryable = 0, cancellable = 0, updated_at = ?
          WHERE id = ? AND state = 'cancelling'
        `).run(now, turnId);
        db.query(`
          UPDATE messages
          SET status = 'cancelled', updated_at = ?
          WHERE turn_id = ? AND role = 'assistant'
            AND status IN ('pending', 'streaming')
        `).run(now, turnId);
      }
    });
    transaction();
  }
}

function hasStopProjectionTables(db: Database): boolean {
  const names = db.query<{ name: string }, []>(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN ('app_turn_cancel_outbox', 'turns', 'btcc_turns')
  `).all().map((row) => row.name);
  return names.length === 3;
}
