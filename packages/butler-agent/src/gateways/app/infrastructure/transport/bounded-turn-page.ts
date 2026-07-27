import type { Database } from "bun:sqlite";

export type BoundedTurnRow = {
  rowId: number;
  turnId: string;
  chatId: string;
  state: string;
};

export type BoundedTurnPage = {
  rows: BoundedTurnRow[];
  nextCursor: number;
  pending: boolean;
};

export function loadBoundedTurnPage(
  db: Database,
  afterRowId: number,
  limit: number,
): BoundedTurnPage {
  const rows = db.query<{
    row_id: number;
    id: string;
    chat_id: string;
    state: string;
  }, [number, number]>(`
    SELECT rowid AS row_id, id, chat_id, state
    FROM turns
    WHERE rowid > ?
    ORDER BY rowid
    LIMIT ?
  `).all(afterRowId, limit + 1);
  const page = rows.slice(0, limit);
  return {
    rows: page.map((row) => ({
      rowId: row.row_id,
      turnId: row.id,
      chatId: row.chat_id,
      state: row.state,
    })),
    nextCursor: page.at(-1)?.row_id ?? afterRowId,
    pending: rows.length > limit,
  };
}
