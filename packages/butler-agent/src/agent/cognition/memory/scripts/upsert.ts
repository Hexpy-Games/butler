// Standalone LanceDB upsert module — kept separate from index.ts to keep
// both files single-purpose.
// Contract: delete all rows matching a session_id, then insert the given rows.
// Callers pre-compute vectors and any other required columns; this module
// does not know about the embedder.

export interface UpsertTable {
  delete(predicate: string): Promise<unknown>;
  add(rows: Array<Record<string, unknown>>): Promise<unknown>;
}

export interface UpsertResult {
  deleted: number;
  inserted: number;
}

function escapeSqlLiteral(s: string): string {
  return s.replace(/'/g, "''");
}

export async function upsertRowsForSession(
  table: UpsertTable,
  sessionId: string,
  rows: Array<Record<string, unknown>>,
): Promise<UpsertResult> {
  const predicate = `session_id = '${escapeSqlLiteral(sessionId)}'`;
  // LanceDB's delete() doesn't report a count — we approximate by trusting the
  // caller's prior count or returning rows.length as the "delta attempted".
  await table.delete(predicate);
  if (rows.length > 0) {
    await table.add(rows);
  }
  return { deleted: rows.length, inserted: rows.length };
}
