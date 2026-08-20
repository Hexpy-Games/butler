import type { Database } from "bun:sqlite";
import { BTCC_SUBSESSION_SCHEMA } from "./subsession-schema.ts";

/**
 * The accepted SS-02 schema admitted only success. SS-02B widens that one
 * result record in place; relation, outbox, and existing success rows remain
 * authoritative and keep their identities.
 */
export function migrateSubsessionResultSchema(db: Database): void {
  const definition = db.query<{ sql: string | null }, []>(`
    SELECT sql FROM sqlite_schema
    WHERE type = 'table' AND name = 'btcc_steward_results'
  `).get()?.sql ?? "";
  if (!definition) return;
  if (
    definition.includes("status IN ('success', 'blocked', 'failed', 'cancelled')") &&
    definition.includes("'delegation_context_incomplete'") &&
    !definition.includes("'task_needs_split'")
  ) {
    addDetailedResultColumns(db);
    return;
  }
  const legacyTable = "btcc_steward_results_ss02_success";
  db.exec(`ALTER TABLE btcc_steward_results RENAME TO ${legacyTable}`);
  db.exec(resultTableSchema());
  db.exec(`
    INSERT INTO btcc_steward_results (
      result_id, relation_id, task_id, child_session_id, child_turn_id,
      status, code, summary, acceptance_evidence_json, changed_artifacts_json,
      created_at
    )
    SELECT result_id, relation_id, task_id, child_session_id, child_turn_id,
      status, NULL, summary, acceptance_evidence_json, changed_artifacts_json,
      created_at
    FROM ${legacyTable}
  `);
  db.exec(`DROP TABLE ${legacyTable}`);
  addDetailedResultColumns(db);
}

function addDetailedResultColumns(db: Database): void {
  const columns = new Set(db.query<{ name: string }, []>(
    "PRAGMA table_info(btcc_steward_results)",
  ).all().map((column) => column.name));
  for (const [name, definition] of [
    ["commits_json", "TEXT NOT NULL DEFAULT '[]'"],
    ["tests_json", "TEXT NOT NULL DEFAULT '[]'"],
    ["remaining_risks_json", "TEXT NOT NULL DEFAULT '[]'"],
    ["follow_up_recommendations_json", "TEXT NOT NULL DEFAULT '[]'"],
    ["detail_refs_json", "TEXT NOT NULL DEFAULT '[]'"],
  ] as const) {
    if (!columns.has(name)) db.exec(`ALTER TABLE btcc_steward_results ADD COLUMN ${name} ${definition}`);
  }
}

function resultTableSchema(): string {
  const start = BTCC_SUBSESSION_SCHEMA.indexOf("CREATE TABLE IF NOT EXISTS btcc_steward_results");
  const end = BTCC_SUBSESSION_SCHEMA.indexOf("CREATE TABLE IF NOT EXISTS btcc_subsession_outbox");
  if (start < 0 || end < 0) throw new Error("subsession_result_schema_missing");
  return BTCC_SUBSESSION_SCHEMA.slice(start, end);
}
