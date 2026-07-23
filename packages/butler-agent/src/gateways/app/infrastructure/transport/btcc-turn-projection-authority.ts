import type { Database } from "bun:sqlite";

type ProjectionAuthorityRow = {
  turn_id: string;
  semantic_state: string;
};

export function btccRetainsTurnAuthority(
  db: Database,
  turnId: string,
): boolean {
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
  let rows: ProjectionAuthorityRow[];
  try {
    rows = db.query<ProjectionAuthorityRow, [string | null, string | null]>(`
      SELECT turns.id AS turn_id, btcc_turns.semantic_state
      FROM turns
      JOIN btcc_turns ON btcc_turns.turn_id = turns.id
      WHERE turns.state IN ('failed', 'runtime_fault')
        AND btcc_turns.semantic_state NOT IN ('delivered', 'cancelled')
        AND (? IS NULL OR turns.chat_id = ?)
      ORDER BY turns.rowid
    `).all(chatId ?? null, chatId ?? null);
  } catch {
    return 0;
  }
  if (rows.length === 0) return 0;
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const row of rows) {
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
  return rows.length;
}

function isBtccTerminal(state: string): boolean {
  return state === "delivered" || state === "cancelled";
}
