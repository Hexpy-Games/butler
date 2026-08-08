import type { Database } from "bun:sqlite";

export function ensureCorrectionSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS btcc_guided_work_disposition_revisions (
      disposition_revision_id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      result_sequence INTEGER NOT NULL DEFAULT 0,
      material_fingerprint TEXT NOT NULL DEFAULT '',
      disposition TEXT NOT NULL CHECK (disposition IN ('completed', 'open', 'blocked')),
      summary TEXT NOT NULL,
      action_updates_json TEXT NOT NULL,
      remaining_actions_json TEXT NOT NULL,
      next_condition TEXT,
      evidence_refs_json TEXT NOT NULL,
      evidence_snapshot_json TEXT NOT NULL,
      followups_json TEXT NOT NULL,
      origin_turn_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(work_id, revision)
    );
    CREATE TABLE IF NOT EXISTS btcc_guided_work_disposition_commands (
      mutation_call_id TEXT PRIMARY KEY,
      request_sha256 TEXT NOT NULL,
      work_id TEXT NOT NULL,
      disposition_revision_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS btcc_operator_correction_audits (
      audit_id TEXT PRIMARY KEY,
      request_fingerprint TEXT NOT NULL UNIQUE,
      correction_version INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      source_work_id TEXT NOT NULL,
      monitoring_turn_ids_json TEXT NOT NULL,
      capture_turn_ids_json TEXT NOT NULL,
      source_db_identity_json TEXT NOT NULL,
      before_snapshot_sha256 TEXT NOT NULL,
      after_snapshot_sha256 TEXT NOT NULL,
      before_snapshot_json TEXT NOT NULL,
      after_snapshot_json TEXT NOT NULL,
      before_counts_json TEXT NOT NULL,
      after_counts_json TEXT NOT NULL,
      operator_id TEXT NOT NULL DEFAULT '',
      operator_reason TEXT NOT NULL,
      backup_identity TEXT NOT NULL DEFAULT '',
      backup_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS btcc_operator_correction_audits_no_update
    BEFORE UPDATE ON btcc_operator_correction_audits
    BEGIN SELECT RAISE(ABORT, 'operator correction audit is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS btcc_operator_correction_audits_no_delete
    BEFORE DELETE ON btcc_operator_correction_audits
    BEGIN SELECT RAISE(ABORT, 'operator correction audit is immutable'); END;
  `);
  ensureColumn(db, "btcc_operator_correction_audits", "operator_id", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "btcc_operator_correction_audits", "backup_identity", "TEXT NOT NULL DEFAULT ''");
}

function ensureColumn(db: Database, table: string, column: string, definition: string): void {
  if (hasColumn(db, table, column)) return;
  db.exec(`ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN ${quoteIdentifier(column)} ${definition}`);
}

export function ensureCaptureEvidenceSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS btcc_guided_work_plan_revisions (
      plan_revision_id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      objective TEXT NOT NULL,
      governing_refs_json TEXT NOT NULL,
      actions_json TEXT NOT NULL,
      checks_json TEXT NOT NULL,
      origin_turn_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(work_id, revision)
    );
    CREATE TABLE IF NOT EXISTS btcc_guided_work_checkpoint_revisions (
      checkpoint_revision_id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      plan_revision_id TEXT NOT NULL,
      stage TEXT NOT NULL CHECK (stage IN ('conception', 'planning', 'execution', 'review', 'validation', 'reporting')),
      public_summary TEXT NOT NULL,
      next_step TEXT NOT NULL,
      action_states_json TEXT NOT NULL,
      result_sequence INTEGER NOT NULL,
      origin_turn_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(work_id, revision)
    );
  `);
}

export function hasTable(db: Database, table: string): boolean {
  return Boolean(db.query<{ present: number }, [string]>(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table));
}

export function hasColumn(db: Database, table: string, column: string): boolean {
  if (!hasTable(db, table)) return false;
  return db.query<{ name: string }, []>(`PRAGMA table_info(${quoteIdentifier(table)})`)
    .all().some((row) => row.name === column);
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`invalid SQLite identifier: ${value}`);
  return value;
}
