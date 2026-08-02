import type { Database } from "bun:sqlite";

type ColumnRow = { name: string };

export function migrateBtccSchema(db: Database): void {
  ensureLegacyWorkImportProvenance(db);
  ensureGuidedWorkProgressColumns(db);
  restoreStableWorkObjectives(db);
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

function ensureGuidedWorkProgressColumns(db: Database): void {
  if (tableExists(db, "btcc_guided_work_plan_revisions")) {
    ensureColumn(
      db,
      "btcc_guided_work_plan_revisions",
      "governing_refs_json",
      "TEXT NOT NULL DEFAULT '[]'",
    );
  }
  if (!tableExists(db, "btcc_guided_work_checkpoint_revisions")) return;
  ensureColumn(
    db,
    "btcc_guided_work_checkpoint_revisions",
    "plan_revision_id",
    "TEXT",
  );
  ensureColumn(
    db,
    "btcc_guided_work_checkpoint_revisions",
    "action_states_json",
    "TEXT NOT NULL DEFAULT '[]'",
  );
}

function restoreStableWorkObjectives(db: Database): void {
  if (
    !tableExists(db, "btcc_guided_works") ||
    !tableExists(db, "btcc_guided_work_plan_revisions")
  ) return;
  db.exec(`
    UPDATE btcc_guided_works
    SET objective = (
      SELECT plan.objective
      FROM btcc_guided_work_plan_revisions plan
      WHERE plan.work_id = btcc_guided_works.work_id
      ORDER BY plan.revision ASC
      LIMIT 1
    )
    WHERE EXISTS (
      SELECT 1 FROM btcc_guided_work_plan_revisions plan
      WHERE plan.work_id = btcc_guided_works.work_id
    )
  `);
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
