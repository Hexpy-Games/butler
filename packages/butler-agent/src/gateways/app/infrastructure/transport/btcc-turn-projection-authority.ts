import type { Database } from "bun:sqlite";
import { loadBoundedTurnPage } from "./bounded-turn-page.ts";

type ProjectionAuthorityRow = {
  turn_id: string;
  semantic_state: string;
};

export type ProjectionAuthorityBatch = {
  applied: number;
  nextCursor: number;
  pending: boolean;
};

const AUTHORITY_BATCH_SIZE = 32;

export function btccRetainsTurnAuthority(db: Database, turnId: string): boolean {
  try {
    const row = db.query<{ semantic_state: string }, [string]>(`
      SELECT semantic_state FROM btcc_turns WHERE turn_id = ?
    `).get(turnId);
    return Boolean(row && !isBtccTerminal(row.semantic_state));
  } catch {
    return false;
  }
}

export function reconcileBtccTurnProjectionAuthority(
  db: Database,
  chatId?: string,
): number {
  return reconcileBtccTurnProjectionAuthorityBatch(db, {
    chatId,
    afterRowId: 0,
  }).applied;
}

export function reconcileBtccTurnProjectionAuthorityBatch(
  db: Database,
  input: { chatId?: string; afterRowId: number; limit?: number },
): ProjectionAuthorityBatch {
  if (!tableExists(db, "btcc_turns")) {
    return { applied: 0, nextCursor: input.afterRowId, pending: false };
  }
  const limit = input.limit ?? AUTHORITY_BATCH_SIZE;
  const page = loadBoundedTurnPage(db, input.afterRowId, limit);
  const candidates = page.rows.filter((row) =>
    (row.state === "failed" || row.state === "runtime_fault") &&
    (!input.chatId || row.chatId === input.chatId),
  );
  const batch = activeBtccRows(db, candidates.map((row) => row.turnId));
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const row of batch) {
      const finalizing = row.semantic_state === "delivery_committed";
      db.query(`
        UPDATE turns
        SET state = 'running', safe_status_label = ?, safe_error_code = NULL,
          retryable = 0, cancellable = ?, updated_at = ?
        WHERE id = ? AND state IN ('failed', 'runtime_fault')
      `).run(finalizing ? "Finalizing" : "Working", finalizing ? 0 : 1, now, row.turn_id);
      db.query(`
        UPDATE messages
        SET text = '', status = 'pending', safe_error_code = NULL,
          retryable = 0, updated_at = ?
        WHERE turn_id = ? AND role = 'assistant' AND status = 'failed'
      `).run(now, row.turn_id);
    }
  })();
  return {
    applied: batch.length,
    nextCursor: page.nextCursor,
    pending: page.pending,
  };
}

function activeBtccRows(db: Database, turnIds: string[]): ProjectionAuthorityRow[] {
  if (turnIds.length === 0) return [];
  const placeholders = turnIds.map(() => "?").join(", ");
  return db.query<ProjectionAuthorityRow, string[]>(`
    SELECT turn_id, semantic_state FROM btcc_turns
    WHERE turn_id IN (${placeholders})
      AND semantic_state NOT IN ('delivered', 'cancelled')
  `).all(...turnIds);
}

function isBtccTerminal(state: string): boolean {
  return state === "delivered" || state === "cancelled";
}

function tableExists(db: Database, name: string): boolean {
  return Boolean(db.query<{ name: string }, [string]>(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(name));
}
