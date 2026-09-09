import type { Database } from "bun:sqlite";
import { BTCC_SUBSESSION_SCHEMA } from "./subsession-schema.ts";

/**
 * The accepted SS-02 schema admitted only success. SS-02B widens that one
 * result record in place; relation, outbox, and existing success rows remain
 * authoritative and keep their identities.
 */
export function migrateSubsessionResultSchema(db: Database): void {
  ensureDelegationDispatchIntent(db);
  const definition = db.query<{ sql: string | null }, []>(`
    SELECT sql FROM sqlite_schema
    WHERE type = 'table' AND name = 'btcc_steward_results'
  `).get()?.sql ?? "";
  if (!definition) return;
  if (
    definition.includes("status IN ('success', 'blocked', 'failed', 'cancelled')") &&
    definition.includes("'delegation_context_incomplete'") &&
    definition.includes("'worker_work_incomplete'") &&
    definition.includes("'worker_no_progress'") &&
    !definition.includes("'task_needs_split'")
  ) {
    addDetailedResultColumns(db);
    migrateFollowupResults(db);
    return;
  }
  const legacyColumns = new Set(db.query<{ name: string }, []>(
    "PRAGMA table_info(btcc_steward_results)",
  ).all().map((column) => column.name));
  const codeSource = definition.includes("'task_needs_split'")
    ? "NULL"
    : sourceColumn(legacyColumns, "code", "NULL");
  const legacyTable = "btcc_steward_results_ss02_success";
  db.exec(`ALTER TABLE btcc_steward_results RENAME TO ${legacyTable}`);
  db.exec(resultTableSchema());
  db.exec(`
    INSERT INTO btcc_steward_results (
      result_id, relation_id, task_id, child_session_id, child_turn_id,
      status, code, summary, acceptance_evidence_json, changed_artifacts_json,
      changed_files_json, commits_json, tests_json, remaining_risks_json,
      follow_up_recommendations_json, detail_refs_json,
      created_at
    )
    SELECT result_id, relation_id, task_id, child_session_id, child_turn_id,
      status, ${codeSource}, summary,
      acceptance_evidence_json, changed_artifacts_json,
      ${sourceColumn(legacyColumns, "changed_files_json", "'[]'")},
      ${sourceColumn(legacyColumns, "commits_json", "'[]'")},
      ${sourceColumn(legacyColumns, "tests_json", "'[]'")},
      ${sourceColumn(legacyColumns, "remaining_risks_json", "'[]'")},
      ${sourceColumn(legacyColumns, "follow_up_recommendations_json", "'[]'")},
      ${sourceColumn(legacyColumns, "detail_refs_json", "'[]'")},
      created_at
    FROM ${legacyTable}
  `);
  db.exec(`DROP TABLE ${legacyTable}`);
  addDetailedResultColumns(db);
  migrateFollowupResults(db);
}

function ensureDelegationDispatchIntent(db: Database): void {
  const table = "btcc_subsession_delegations";
  const exists = db.query<{ present: number }, [string]>(`
    SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?
  `).get(table);
  if (!exists) return;
  const columns = db.query<{ name: string }, []>(
    `PRAGMA table_info(${table})`,
  ).all();
  const names = new Set(columns.map(({ name }) => name));
  if (!names.has("dispatch_intent_json")) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN dispatch_intent_json TEXT`);
  }
  if (!names.has("dispatch_state")) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN dispatch_state TEXT
      CHECK (dispatch_state IS NULL OR dispatch_state IN ('pending', 'enqueued'))`);
  }
}

function sourceColumn(
  columns: ReadonlySet<string>,
  name: string,
  fallback: string,
): string {
  return columns.has(name) ? name : fallback;
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
    ["changed_files_json", "TEXT NOT NULL DEFAULT '[]'"],
    ["direction_revision", "INTEGER NOT NULL DEFAULT 0"],
  ] as const) {
    if (!columns.has(name)) db.exec(`ALTER TABLE btcc_steward_results ADD COLUMN ${name} ${definition}`);
  }
}

/** Preserve every accepted report/outbox row; later directions append reports. */
function migrateFollowupResults(db: Database): void {
  db.transaction(() => {
    for (const table of ["btcc_steward_results", "btcc_subsession_outbox"] as const) {
      const sql = db.query<{ sql: string }, [string]>(
        "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?",
      ).get(table)?.sql;
      if (!sql?.includes("relation_id TEXT NOT NULL UNIQUE")) continue;
      const columns = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`)
        .all().map((column) => column.name).join(", ");
      const start = BTCC_SUBSESSION_SCHEMA.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
      const end = BTCC_SUBSESSION_SCHEMA.indexOf(";", start) + 1;
      db.exec(`ALTER TABLE ${table} RENAME TO ${table}_before_followup`);
      db.exec(BTCC_SUBSESSION_SCHEMA.slice(start, end));
      db.exec(`INSERT INTO ${table} (${columns}) SELECT ${columns} FROM ${table}_before_followup ORDER BY rowid`);
      db.exec(`DROP TABLE ${table}_before_followup`);
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_steward_results_relation ON btcc_steward_results(relation_id)");
  }).immediate();
}

function resultTableSchema(): string {
  const start = BTCC_SUBSESSION_SCHEMA.indexOf("CREATE TABLE IF NOT EXISTS btcc_steward_results");
  const end = BTCC_SUBSESSION_SCHEMA.indexOf("CREATE TABLE IF NOT EXISTS btcc_subsession_outbox");
  if (start < 0 || end < 0) throw new Error("subsession_result_schema_missing");
  return BTCC_SUBSESSION_SCHEMA.slice(start, end);
}
