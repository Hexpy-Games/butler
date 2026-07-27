import type { Database } from "bun:sqlite";

const SETTLED_BTCC_STATES = new Set(["delivered", "cancelled"]);
const TERMINAL_APP_STATES = new Set([
  "delivered",
  "failed",
  "cancelled",
  "runtime_fault",
]);
const SETTLED_SCAN_FACTOR = 5;
const REVISION_DELETE_BATCH = 8;

export class SqliteBtccTerminalPhaseRetention {
  private phaseRevisionScanCursor = 0;

  constructor(
    private readonly db: Database,
    private readonly appTurnState: (turnId: string) => string | null,
    private readonly retainedProjectionReady: (turnId: string) => boolean,
  ) {}

  isSettled(turnId: string): boolean {
    if (!this.tableExists("btcc_turns")) return true;
    const row = this.db.query<{ semantic_state: string }, [string]>(`
      SELECT semantic_state FROM btcc_turns WHERE turn_id = ?
    `).get(turnId);
    return !row || SETTLED_BTCC_STATES.has(row.semantic_state);
  }

  compactTurn(turnId: string): boolean {
    if (
      !this.isSettled(turnId) ||
      !this.retainedProjectionReady(turnId) ||
      !this.tableExists("btcc_checkpoints")
    ) return false;
    const rows = this.db.query<{ row_id: number }, [string, number]>(`
      SELECT revision.rowid AS row_id
      FROM btcc_phase_checkpoint_revisions AS revision
      JOIN btcc_checkpoints AS checkpoint
        ON checkpoint.checkpoint_id = revision.checkpoint_id
      WHERE checkpoint.turn_id = ?
      ORDER BY revision.rowid
      LIMIT ?
    `).all(turnId, REVISION_DELETE_BATCH + 1);
    const batch = rows.slice(0, REVISION_DELETE_BATCH);
    if (batch.length > 0) {
      const placeholders = batch.map(() => "?").join(", ");
      this.db.query(`
        DELETE FROM btcc_phase_checkpoint_revisions
        WHERE rowid IN (${placeholders})
      `).run(...batch.map((row) => row.row_id));
    }
    return rows.length > REVISION_DELETE_BATCH;
  }

  compactSettledBatch(limit = 1): boolean {
    if (!this.tableExists("btcc_turns")) return false;
    const scanLimit = limit * SETTLED_SCAN_FACTOR;
    const rows = this.db.query<{
      turn_id: string;
      revision_row_id: number;
    }, [number, number]>(`
      SELECT checkpoint.turn_id, revision.rowid AS revision_row_id
      FROM btcc_phase_checkpoint_revisions AS revision
      JOIN btcc_checkpoints AS checkpoint
        ON checkpoint.checkpoint_id = revision.checkpoint_id
      WHERE revision.rowid > ?
      ORDER BY revision.rowid
      LIMIT ?
    `).all(this.phaseRevisionScanCursor, scanLimit + 1);
    const page = rows.slice(0, scanLimit);
    const hasMore = rows.length > scanLimit;
    const eligible: Array<{ turn_id: string }> = [];
    const visited = new Set<string>();
    let lastScannedRowId: number | undefined;
    for (const row of page) {
      lastScannedRowId = row.revision_row_id;
      if (visited.has(row.turn_id)) continue;
      visited.add(row.turn_id);
      if (!this.isSettled(row.turn_id)) continue;
      const state = this.appTurnState(row.turn_id);
      if (state !== null && !TERMINAL_APP_STATES.has(state)) continue;
      if (!this.retainedProjectionReady(row.turn_id)) continue;
      eligible.push({ turn_id: row.turn_id });
      if (eligible.length === limit) break;
    }
    if (eligible.length > 0) {
      this.db.transaction(() => {
        for (const row of eligible) this.compactTurn(row.turn_id);
      })();
    }
    if (lastScannedRowId !== undefined) {
      this.phaseRevisionScanCursor = lastScannedRowId;
    }
    if (hasMore || eligible.length > 0) return true;
    this.phaseRevisionScanCursor = 0;
    return false;
  }

  private tableExists(name: string): boolean {
    return Boolean(this.db.query<{ name: string }, [string]>(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?
    `).get(name));
  }
}
