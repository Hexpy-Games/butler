import type { Database } from "bun:sqlite";
import { BTCC_AUTHORITY_SCHEMA } from "./authority-schema.ts";

type ColumnRow = { name: string };

/** Evolves only the durable authority columns owned by AF-02C. */
export function migrateAuthoritySchema(db: Database): void {
  migrateLegacyDecisionConstraint(db);
  ensureAuthorityColumns(db);
}

function migrateLegacyDecisionConstraint(db: Database): void {
  const definition = tableDefinition(db, "btcc_authority_requests");
  if (!definition || !hasLegacyDecisionCheck(definition)) return;

  const legacyTable = "btcc_authority_requests_af02a_legacy";
  db.exec(`ALTER TABLE btcc_authority_requests RENAME TO ${legacyTable}`);
  db.exec("DROP INDEX IF EXISTS idx_btcc_authority_requests_owner_pending");
  db.exec("DROP INDEX IF EXISTS idx_btcc_authority_requests_slot_action");
  db.exec(BTCC_AUTHORITY_SCHEMA);
  db.exec(`
    INSERT INTO btcc_authority_requests (
      request_id, request_ref, identity_sha256, owner_session_id,
      source_session_id, source_turn_id, source_work_id, workspace_path,
      plan_revision_id, action_key, authority_generation, capability,
      normalized_target, normalized_input_json, model_ref, reasoning_effort,
      category, reason, executable, command_count, decision, schedule_state,
      schedule_client_message_id, schedule_input_text, outcome,
      outcome_receipt_json, created_at, updated_at
    )
    SELECT request_id, request_ref, identity_sha256, owner_session_id,
      source_session_id, source_turn_id, source_work_id, workspace_path,
      plan_revision_id, action_key, authority_generation, capability,
      normalized_target, normalized_input_json, model_ref, reasoning_effort,
      category, reason, executable, command_count, decision, schedule_state,
      schedule_client_message_id, schedule_input_text, outcome,
      outcome_receipt_json, created_at, updated_at
    FROM ${legacyTable}
    ORDER BY rowid
  `);
  db.exec(`DROP TABLE ${legacyTable}`);
}

function hasLegacyDecisionCheck(definition: string): boolean {
  return /\bdecision\b/iu.test(definition) && !definition.includes("'modified'");
}

function ensureAuthorityColumns(db: Database): void {
  if (!tableExists(db, "btcc_authority_requests")) return;
  ensureColumn(db, "btcc_authority_requests", "schedule_turn_id", "TEXT");
  ensureColumn(db, "btcc_authority_requests", "private_alternative_input", "TEXT");
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

function tableDefinition(db: Database, name: string): string | null {
  return db.query<{ sql: string | null }, [string]>(`
    SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?
  `).get(name)?.sql ?? null;
}

function tableExists(db: Database, name: string): boolean {
  return Boolean(db.query<{ name: string }, [string]>(`
    SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?
  `).get(name));
}
