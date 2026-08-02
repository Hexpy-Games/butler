import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { Btcc } from "../../../agent/btcc/index.ts";

type PendingStopRow = {
  turn_id: string;
  state: string;
};

type BtccProgressProjection = {
  hasCommittedEvent(turnId: string, kind: string): boolean;
};

/** App cancellation Outbox consumer; it projects BTCC's Stop receipt only. */
export class AppBtccStopConsumer {
  private running: Promise<void> | null = null;

  constructor(
    private readonly dbPath: string,
    private readonly btcc: Pick<Btcc, "stopTurn">,
    private readonly progress: BtccProgressProjection,
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
        const outcome = await this.btcc.stopTurn({ turnId: row.turn_id });
        if (outcome.kind === "fenced_pending_persistence") continue;
        if (!this.hasCanonicalCancellation(row.turn_id)) continue;
        this.acknowledgeCanonicalCancellation(db, row.turn_id);
      }
    } finally {
      db.close();
    }
  }

  private hasCanonicalCancellation(turnId: string): boolean {
    return this.progress.hasCommittedEvent(turnId, "turn.cancelled");
  }

  private acknowledgeCanonicalCancellation(db: Database, turnId: string): void {
    const transaction = db.transaction(() => {
      const now = new Date().toISOString();
      db.query(`
        UPDATE app_turn_cancel_outbox
        SET state = 'completed', accepted_at = COALESCE(accepted_at, ?),
          completed_at = ?, safe_error_code = NULL
          WHERE turn_id = ? AND state IN ('pending', 'accepted')
      `).run(now, now, turnId);
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
