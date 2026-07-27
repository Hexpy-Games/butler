import type { Database } from "bun:sqlite";

const SETTLEMENT_WAKE_BATCH_SIZE = 32;

export type TerminalSettlementWakeBatch = {
  consumed: number;
  pending: boolean;
};

export class TerminalSettlementWakeStore {
  constructor(private readonly db: Database) {}

  consumeNextBatch(
    schedule: (turnId: string) => void,
  ): TerminalSettlementWakeBatch {
    if (!this.schemaExists()) return { consumed: 0, pending: false };
    const rows = this.db.query<{ turn_id: string }, [number]>(`
      SELECT turn_id FROM btcc_terminal_settlement_wakes
      ORDER BY rowid
      LIMIT ?
    `).all(SETTLEMENT_WAKE_BATCH_SIZE + 1);
    const batch = rows.slice(0, SETTLEMENT_WAKE_BATCH_SIZE);
    for (const row of batch) {
      schedule(row.turn_id);
      this.db.query(`
        DELETE FROM btcc_terminal_settlement_wakes WHERE turn_id = ?
      `).run(row.turn_id);
    }
    return {
      consumed: batch.length,
      pending: rows.length > SETTLEMENT_WAKE_BATCH_SIZE,
    };
  }

  private schemaExists(): boolean {
    return Boolean(this.db.query<{ name: string }, []>(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'btcc_terminal_settlement_wakes'
    `).get());
  }
}
