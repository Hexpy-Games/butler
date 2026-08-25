import type { Database } from "bun:sqlite";
import {
  BTCC_GUIDED_WORK_CHECKPOINT_TABLE_SCHEMA,
  BTCC_GUIDED_WORK_DISPOSITION_TABLE_SCHEMA,
  BTCC_GUIDED_WORK_REVIEW_TABLE_SCHEMA,
} from "./guided-work-schema.ts";
import { BTCC_GUIDED_EFFECT_RECOVERY_PAYLOAD_TABLE_SCHEMA } from "./guided-effect-schema.ts";
import { migrateAuthoritySchema } from "./authority-schema-migration.ts";
import { migrateSubsessionResultSchema } from "./subsession-schema-migration.ts";

type ColumnRow = { name: string };

export function migrateBtccSchema(db: Database): void {
  db.transaction(() => {
    migrateAuthoritySchema(db);
    migrateSubsessionResultSchema(db);
    ensureLegacyWorkImportProvenance(db);
    ensureGuidedToolJournalOrder(db);
    ensureGuidedWorkResultOrder(db);
    ensureProjectWorkProjectionColumns(db);
    ensureGuidedWorkDispositionSchema(db);
    ensureGuidedEffectRecoveryPayloadTable(db);
    ensureGuidedWorkDispositionSchema(db);
    ensureGuidedWorkProgressColumns(db);
    ensureTurnProgressDestination(db);
    ensureTurnRouteState(db);
    ensureTurnContinuationBudget(db);
    ensureModelRoundAcceptanceCheckpoint(db);
    ensureModelRouteFailureDisposition(db);
    ensureGuidedToolResultDeliveryColumns(db);
    migrateGuidedWorkSixStageConstraints(db);
    restoreStableWorkObjectives(db);
  }).immediate();
}

function ensureProjectWorkProjectionColumns(db: Database): void {
  if (!tableExists(db, "btcc_guided_works")) return;
  ensureColumn(db, "btcc_guided_works", "ledger_project_id", "TEXT");
  ensureColumn(db, "btcc_guided_works", "canonical_head_sha256", "TEXT");
}

function ensureGuidedWorkDispositionSchema(db: Database): void {
  if (!tableExists(db, "btcc_guided_works")) return;
  db.exec(BTCC_GUIDED_WORK_DISPOSITION_TABLE_SCHEMA);
  if (!tableExists(db, "btcc_guided_work_disposition_revisions")) return;
  ensureColumn(
    db,
    "btcc_guided_work_disposition_revisions",
    "result_sequence",
    "INTEGER NOT NULL DEFAULT 0",
  );
  ensureColumn(
    db,
    "btcc_guided_work_disposition_revisions",
    "material_fingerprint",
    "TEXT NOT NULL DEFAULT ''",
  );
  ensureColumn(
    db,
    "btcc_guided_work_disposition_revisions",
    "runtime_owned_open",
    "INTEGER NOT NULL DEFAULT 0",
  );
}

function ensureTurnContinuationBudget(db: Database): void {
  if (!tableExists(db, "btcc_turns")) return;
  ensureColumn(db, "btcc_turns", "continuation_budget_json", "TEXT");
}

function ensureGuidedToolResultDeliveryColumns(db: Database): void {
  if (!tableExists(db, "btcc_guided_tool_calls")) return;
  ensureColumn(db, "btcc_guided_tool_calls", "delivery_state", "TEXT");
  ensureColumn(db, "btcc_guided_tool_calls", "delivery_round_id", "TEXT");
  ensureColumn(db, "btcc_guided_tool_calls", "delivery_response_sha256", "TEXT");
}

function ensureGuidedWorkResultOrder(db: Database): void {
  const table = "btcc_guided_work_results";
  if (!tableExists(db, table)) return;
  ensureColumn(db, table, "source_turn_rowid", "INTEGER");
  ensureColumn(db, table, "source_turn_sequence", "INTEGER");
  if (tableExists(db, "btcc_turns")) {
    db.exec(`
      UPDATE ${table}
      SET source_turn_rowid = (
        SELECT turns.rowid FROM btcc_turns turns
        WHERE turns.turn_id = ${table}.origin_turn_id
      )
      WHERE source_turn_rowid IS NULL
    `);
  }
  if (tableExists(db, "btcc_guided_tool_calls")) {
    db.exec(`
      UPDATE ${table}
      SET source_turn_sequence = (
        SELECT calls.turn_sequence FROM btcc_guided_tool_calls calls
        WHERE calls.call_id = ${table}.tool_call_id
      )
      WHERE source_turn_sequence IS NULL
    `);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_btcc_guided_work_results_source_order
    ON ${table}(work_id, source_turn_rowid, source_turn_sequence, sequence)
  `);
}

function ensureGuidedToolJournalOrder(db: Database): void {
  const table = "btcc_guided_tool_calls";
  if (!tableExists(db, table)) return;
  ensureColumn(db, table, "turn_sequence", "INTEGER");
  const rows = db.query<{
    rowid: number;
    turn_id: string;
    turn_sequence: number | null;
  }, []>(`
    SELECT rowid, turn_id, turn_sequence
    FROM ${table}
    ORDER BY turn_id, rowid
  `).all();
  const nextByTurn = new Map<string, number>();
  for (const row of rows) {
    const current = nextByTurn.get(row.turn_id) ?? 0;
    if (row.turn_sequence !== null) {
      nextByTurn.set(row.turn_id, Math.max(current, row.turn_sequence));
      continue;
    }
    const next = current + 1;
    db.query(`
      UPDATE ${table} SET turn_sequence = ? WHERE rowid = ?
    `).run(next, row.rowid);
    nextByTurn.set(row.turn_id, next);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_btcc_guided_tool_calls_turn_sequence
    ON ${table}(turn_id, turn_sequence)
  `);
}

function ensureGuidedEffectRecoveryPayloadTable(db: Database): void {
  // Older databases have only the fixed-column single-edit hint table. Keep
  // that table untouched and add one bounded JSON payload table for batches.
  db.exec(BTCC_GUIDED_EFFECT_RECOVERY_PAYLOAD_TABLE_SCHEMA);
}

function ensureModelRouteFailureDisposition(db: Database): void {
  if (!tableExists(db, "btcc_model_route_events")) return;
  ensureColumn(db, "btcc_model_route_events", "failure_disposition", "TEXT");
}

function ensureTurnProgressDestination(db: Database): void {
  if (!tableExists(db, "btcc_turns")) return;
  ensureColumn(db, "btcc_turns", "progress_destination_json", "TEXT");
}

function ensureTurnRouteState(db: Database): void {
  if (!tableExists(db, "btcc_turns")) return;
  ensureColumn(db, "btcc_turns", "route_state_json", "TEXT");
}

function ensureModelRoundAcceptanceCheckpoint(db: Database): void {
  if (!tableExists(db, "btcc_model_round_acceptances")) return;
  // Acceptance rows created before checkpoint binding are intentionally made
  // non-replayable (empty/zero link) rather than guessed onto a new claim.
  ensureColumn(
    db,
    "btcc_model_round_acceptances",
    "checkpoint_id",
    "TEXT NOT NULL DEFAULT ''",
  );
  ensureColumn(
    db,
    "btcc_model_round_acceptances",
    "checkpoint_revision",
    "INTEGER NOT NULL DEFAULT 0",
  );
}

function migrateGuidedWorkSixStageConstraints(db: Database): void {
  migrateGuidedWorkCheckpointConstraints(db);
  migrateGuidedWorkReviewConstraints(db);
  // R3-11 completed Work remains historical truth. Do not synthesize a
  // completion Validation or reopen it while widening the durable schema.
}

function migrateGuidedWorkCheckpointConstraints(db: Database): void {
  const definition = tableDefinition(db, "btcc_guided_work_checkpoint_revisions");
  if (!definition || definition.includes("'validation'")) return;
  const legacyTable = "btcc_guided_work_checkpoint_revisions_r3_11";
  db.exec(`
    ALTER TABLE btcc_guided_work_checkpoint_revisions RENAME TO ${legacyTable}
  `);
  db.exec(BTCC_GUIDED_WORK_CHECKPOINT_TABLE_SCHEMA.replace(
    "  plan_revision_id TEXT NOT NULL,",
    "  plan_revision_id TEXT,",
  ));
  db.exec(`
    INSERT INTO btcc_guided_work_checkpoint_revisions (
      checkpoint_revision_id, work_id, revision, plan_revision_id, stage,
      public_summary, next_step, action_states_json, result_sequence,
      origin_turn_id, created_at
    )
    SELECT checkpoint_revision_id, work_id, revision, plan_revision_id, stage,
      public_summary, next_step, action_states_json, result_sequence,
      origin_turn_id, created_at
    FROM ${legacyTable}
    ORDER BY work_id, revision
  `);
  db.exec(`DROP TABLE ${legacyTable}`);
}

function migrateGuidedWorkReviewConstraints(db: Database): void {
  const table = "btcc_guided_work_review_revisions";
  const definition = tableDefinition(db, table);
  if (
    !definition ||
    (definition.includes("'completion'") &&
      columnExists(db, table, "bound_result_review_revision_id") &&
      columnExists(db, table, "bound_action_states_json"))
  ) return;
  const hasResultReviewBinding = columnExists(
    db,
    table,
    "bound_result_review_revision_id",
  );
  const hasActionSnapshot = columnExists(db, table, "bound_action_states_json");
  const legacyTable = "btcc_guided_work_review_revisions_r3_11";
  db.exec(`ALTER TABLE ${table} RENAME TO ${legacyTable}`);
  db.exec(BTCC_GUIDED_WORK_REVIEW_TABLE_SCHEMA);
  db.exec(`
    INSERT INTO btcc_guided_work_review_revisions (
      review_revision_id, work_id, revision, subject, verdict, summary,
      corrections_json, bound_plan_revision_id, bound_result_sequence,
      bound_result_review_revision_id, bound_action_states_json,
      origin_turn_id, created_at
    )
    SELECT review_revision_id, work_id, revision, subject, verdict, summary,
      corrections_json, bound_plan_revision_id, bound_result_sequence,
      ${hasResultReviewBinding ? "bound_result_review_revision_id" : "NULL"},
      ${hasActionSnapshot ? "bound_action_states_json" : "NULL"},
      origin_turn_id, created_at
    FROM ${legacyTable}
    ORDER BY work_id, revision
  `);
  db.exec(`DROP TABLE ${legacyTable}`);
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

function columnExists(db: Database, table: string, column: string): boolean {
  return db.query<ColumnRow, []>(`PRAGMA table_info(${table})`).all()
    .some((candidate) => candidate.name === column);
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
