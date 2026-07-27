import type { Database } from "bun:sqlite";

export function ensureColumn(
  db: Database,
  table: string,
  column: string,
  definition: string,
): void {
  const rows = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  if (rows.some((row) => row.name === column)) return;
  db.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
}

export function tableExists(db: Database, table: string): boolean {
  return Boolean(db.query<{ name: string }, [string]>(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(table));
}
