import type { Database } from "bun:sqlite";

type ColumnRow = { name: string };

export function migrateBtccSchema(db: Database): void {
  ensureLegacyWorkImportProvenance(db);
}

function ensureLegacyWorkImportProvenance(db: Database): void {
  if (!tableExists(db, "btcc_guided_work_legacy_imports")) return;
  ensureColumn(
    db,
    "btcc_guided_work_legacy_imports",
    "source_authority",
    "TEXT NOT NULL DEFAULT 'session_sqlite'",
  );
  ensureColumn(
    db,
    "btcc_guided_work_legacy_imports",
    "source_revision",
    "TEXT NOT NULL DEFAULT 'unknown'",
  );
}

function ensureColumn(
  db: Database,
  table: string,
  column: string,
  declaration: string,
): void {
  const columns = db.query<ColumnRow, []>(`PRAGMA table_info(${table})`).all();
  if (columns.some((candidate) => candidate.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
}

function tableExists(db: Database, name: string): boolean {
  return Boolean(db.query<{ name: string }, [string]>(`
    SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?
  `).get(name));
}
