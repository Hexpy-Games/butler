import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type {
  AgentBtccMigrationReceipt,
  AgentBtccMigrationTableReceipt,
} from "./contracts.ts";
import { AGENT_BTCC_STATEFUL_TABLES } from "./manifest.ts";

type CopyableValue = string | number | bigint | Uint8Array | null;
type TableInfo = { name: string; pk: number; hidden?: number };
type ReferenceRule = {
  name: string;
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  sourceFilter?: string;
};

const DURABLE_REFERENCE_RULES: readonly ReferenceRule[] = [
  { name: "turn_inbox", fromTable: "btcc_turns", fromColumn: "inbox_id", toTable: "btcc_inbound_inbox", toColumn: "inbox_id" },
  { name: "turn_checkpoint", fromTable: "btcc_turns", fromColumn: "active_checkpoint_id", toTable: "btcc_checkpoints", toColumn: "checkpoint_id" },
  { name: "turn_outbox", fromTable: "btcc_turns", fromColumn: "delivery_outbox_id", toTable: "btcc_delivery_outbox", toColumn: "outbox_id" },
  { name: "turn_message", fromTable: "btcc_turns", fromColumn: "canonical_assistant_message_id", toTable: "btcc_messages", toColumn: "message_id" },
  { name: "admission_inbox", fromTable: "btcc_admission_claims", fromColumn: "inbox_id", toTable: "btcc_inbound_inbox", toColumn: "inbox_id" },
  { name: "admission_owner", fromTable: "btcc_admission_claims", fromColumn: "owner_id", toTable: "btcc_runtime_owners", toColumn: "owner_id" },
  { name: "checkpoint_turn", fromTable: "btcc_checkpoints", fromColumn: "turn_id", toTable: "btcc_turns", toColumn: "turn_id" },
  { name: "checkpoint_claim", fromTable: "btcc_checkpoints", fromColumn: "active_claim_id", toTable: "btcc_state_claims", toColumn: "claim_id" },
  { name: "state_claim_turn", fromTable: "btcc_state_claims", fromColumn: "turn_id", toTable: "btcc_turns", toColumn: "turn_id" },
  { name: "state_claim_checkpoint", fromTable: "btcc_state_claims", fromColumn: "checkpoint_id", toTable: "btcc_checkpoints", toColumn: "checkpoint_id" },
  { name: "state_claim_owner", fromTable: "btcc_state_claims", fromColumn: "owner_id", toTable: "btcc_runtime_owners", toColumn: "owner_id" },
  { name: "outbox_turn", fromTable: "btcc_delivery_outbox", fromColumn: "turn_id", toTable: "btcc_turns", toColumn: "turn_id" },
  { name: "delivery_turn", fromTable: "btcc_canonical_deliveries", fromColumn: "turn_id", toTable: "btcc_turns", toColumn: "turn_id" },
  { name: "delivery_outbox", fromTable: "btcc_canonical_deliveries", fromColumn: "outbox_id", toTable: "btcc_delivery_outbox", toColumn: "outbox_id" },
  { name: "tool_turn", fromTable: "btcc_guided_tool_calls", fromColumn: "turn_id", toTable: "btcc_turns", toColumn: "turn_id" },
  { name: "progress_turn", fromTable: "btcc_progress_events", fromColumn: "turn_id", toTable: "btcc_turns", toColumn: "turn_id" },
  { name: "continuation_turn", fromTable: "btcc_continuation_triggers", fromColumn: "turn_id", toTable: "btcc_turns", toColumn: "turn_id" },
  { name: "continuation_source_turn", fromTable: "btcc_continuation_triggers", fromColumn: "source_turn_id", toTable: "btcc_turns", toColumn: "turn_id" },
  { name: "wake_fact_turn", fromTable: "btcc_wake_request_facts", fromColumn: "turn_id", toTable: "btcc_turns", toColumn: "turn_id" },
  { name: "wake_fact_source_turn", fromTable: "btcc_wake_request_facts", fromColumn: "source_turn_id", toTable: "btcc_turns", toColumn: "turn_id" },
  { name: "route_turn", fromTable: "btcc_model_route_events", fromColumn: "turn_id", toTable: "btcc_turns", toColumn: "turn_id" },
  { name: "acceptance_turn", fromTable: "btcc_model_round_acceptances", fromColumn: "turn_id", toTable: "btcc_turns", toColumn: "turn_id" },
  { name: "work_head", fromTable: "btcc_guided_work_session_heads", fromColumn: "work_id", toTable: "btcc_guided_works", toColumn: "work_id" },
  { name: "work_origin_turn", fromTable: "btcc_guided_works", fromColumn: "origin_turn_id", toTable: "btcc_turns", toColumn: "turn_id" },
  { name: "work_current_plan", fromTable: "btcc_guided_works", fromColumn: "current_plan_revision_id", toTable: "btcc_guided_work_plan_revisions", toColumn: "plan_revision_id", sourceFilter: "source.scope_kind != 'project'" },
  { name: "work_binding", fromTable: "btcc_guided_turn_work_bindings", fromColumn: "work_id", toTable: "btcc_guided_works", toColumn: "work_id" },
  { name: "work_binding_turn", fromTable: "btcc_guided_turn_work_bindings", fromColumn: "turn_id", toTable: "btcc_turns", toColumn: "turn_id" },
  { name: "work_plan", fromTable: "btcc_guided_work_plan_revisions", fromColumn: "work_id", toTable: "btcc_guided_works", toColumn: "work_id" },
  { name: "work_plan_origin_turn", fromTable: "btcc_guided_work_plan_revisions", fromColumn: "origin_turn_id", toTable: "btcc_turns", toColumn: "turn_id" },
  { name: "work_checkpoint", fromTable: "btcc_guided_work_checkpoint_revisions", fromColumn: "work_id", toTable: "btcc_guided_works", toColumn: "work_id" },
  { name: "work_checkpoint_origin_turn", fromTable: "btcc_guided_work_checkpoint_revisions", fromColumn: "origin_turn_id", toTable: "btcc_turns", toColumn: "turn_id" },
  { name: "checkpoint_plan", fromTable: "btcc_guided_work_checkpoint_revisions", fromColumn: "plan_revision_id", toTable: "btcc_guided_work_plan_revisions", toColumn: "plan_revision_id" },
  { name: "work_review", fromTable: "btcc_guided_work_review_revisions", fromColumn: "work_id", toTable: "btcc_guided_works", toColumn: "work_id" },
  { name: "work_review_origin_turn", fromTable: "btcc_guided_work_review_revisions", fromColumn: "origin_turn_id", toTable: "btcc_turns", toColumn: "turn_id" },
  { name: "review_plan", fromTable: "btcc_guided_work_review_revisions", fromColumn: "bound_plan_revision_id", toTable: "btcc_guided_work_plan_revisions", toColumn: "plan_revision_id" },
  { name: "review_result", fromTable: "btcc_guided_work_review_revisions", fromColumn: "bound_result_review_revision_id", toTable: "btcc_guided_work_review_revisions", toColumn: "review_revision_id" },
  { name: "work_disposition", fromTable: "btcc_guided_work_disposition_revisions", fromColumn: "work_id", toTable: "btcc_guided_works", toColumn: "work_id" },
  { name: "work_disposition_origin_turn", fromTable: "btcc_guided_work_disposition_revisions", fromColumn: "origin_turn_id", toTable: "btcc_turns", toColumn: "turn_id" },
  { name: "work_disposition_command", fromTable: "btcc_guided_work_disposition_commands", fromColumn: "work_id", toTable: "btcc_guided_works", toColumn: "work_id" },
  { name: "work_disposition_command_revision", fromTable: "btcc_guided_work_disposition_commands", fromColumn: "disposition_revision_id", toTable: "btcc_guided_work_disposition_revisions", toColumn: "disposition_revision_id" },
  { name: "work_closeout_diagnostic", fromTable: "btcc_guided_work_closeout_diagnostics", fromColumn: "work_id", toTable: "btcc_guided_works", toColumn: "work_id" },
  { name: "work_closeout_diagnostic_turn", fromTable: "btcc_guided_work_closeout_diagnostics", fromColumn: "turn_id", toTable: "btcc_turns", toColumn: "turn_id" },
  { name: "work_mutation", fromTable: "btcc_guided_work_mutations", fromColumn: "work_id", toTable: "btcc_guided_works", toColumn: "work_id" },
  { name: "work_result", fromTable: "btcc_guided_work_results", fromColumn: "work_id", toTable: "btcc_guided_works", toColumn: "work_id" },
  { name: "work_result_origin_turn", fromTable: "btcc_guided_work_results", fromColumn: "origin_turn_id", toTable: "btcc_turns", toColumn: "turn_id" },
  { name: "work_result_tool", fromTable: "btcc_guided_work_results", fromColumn: "tool_call_id", toTable: "btcc_guided_tool_calls", toColumn: "call_id" },
  { name: "effect_work", fromTable: "btcc_guided_effects", fromColumn: "work_id", toTable: "btcc_guided_works", toColumn: "work_id" },
  {
    name: "effect_plan",
    fromTable: "btcc_guided_effects",
    fromColumn: "plan_revision_id",
    toTable: "btcc_guided_work_plan_revisions",
    toColumn: "plan_revision_id",
    sourceFilter: `NOT EXISTS (
      SELECT 1 FROM btcc_guided_works work
      WHERE work.work_id = source.work_id AND work.scope_kind = 'project'
    )`,
  },
  { name: "effect_hint", fromTable: "btcc_guided_effect_recovery_hints", fromColumn: "effect_id", toTable: "btcc_guided_effects", toColumn: "effect_id" },
  { name: "effect_payload", fromTable: "btcc_guided_effect_recovery_payloads", fromColumn: "effect_id", toTable: "btcc_guided_effects", toColumn: "effect_id" },
  { name: "effect_blocker_work", fromTable: "btcc_guided_work_effect_blockers", fromColumn: "work_id", toTable: "btcc_guided_works", toColumn: "work_id" },
  { name: "effect_blocker_source_turn", fromTable: "btcc_guided_work_effect_blockers", fromColumn: "source_turn_id", toTable: "btcc_turns", toColumn: "turn_id" },
  { name: "legacy_import_work", fromTable: "btcc_guided_work_legacy_imports", fromColumn: "work_id", toTable: "btcc_guided_works", toColumn: "work_id" },
];

export function copyAndValidateStatefulTables(
  source: Database | undefined,
  target: Database,
): AgentBtccMigrationTableReceipt[] {
  return AGENT_BTCC_STATEFUL_TABLES.map((table) =>
    copyAndValidateTable(source, target, table),
  );
}

export function snapshotStatefulTables(
  db: Database,
): AgentBtccMigrationTableReceipt[] {
  return AGENT_BTCC_STATEFUL_TABLES.map((table) =>
    tableReceipt(db, table, tableColumns(db, table)),
  );
}

export function validateReceiptSnapshot(
  db: Database,
  receipt: AgentBtccMigrationReceipt,
): void {
  for (const expected of receipt.tables) {
    const actual = tableReceipt(db, expected.name, tableColumns(db, expected.name));
    if (actual.rowCount !== expected.rowCount || actual.contentSha256 !== expected.contentSha256) {
      throw new Error(`agent_btcc_storage_receipt_table_mismatch:${expected.name}`);
    }
  }
}

export function validateCanonicalManifest(db: Database): void {
  const actual = btccTableNames(db);
  const expected = [...AGENT_BTCC_STATEFUL_TABLES];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("agent_btcc_canonical_manifest_mismatch");
  }
}

export function validateAgentBtccDatabase(db: Database): void {
  const quick = db.query<Record<string, string>, []>("PRAGMA quick_check").get();
  if (!quick || Object.values(quick)[0] !== "ok") {
    throw new Error("agent_btcc_migration_quick_check_failed");
  }
  if (db.query("PRAGMA foreign_key_check").all().length > 0) {
    throw new Error("agent_btcc_migration_reference_check_failed");
  }
  for (const rule of DURABLE_REFERENCE_RULES) validateReferenceRule(db, rule);
  const invalidStop = db.query(`
    SELECT 1 FROM btcc_stop_requests AS stop
    LEFT JOIN btcc_turns AS turn ON turn.turn_id = stop.turn_id
    WHERE turn.turn_id IS NULL AND stop.status != 'cancelled_before_admission'
    LIMIT 1
  `).get();
  if (invalidStop) {
    throw new Error("agent_btcc_migration_reference_check_failed:stop_turn");
  }
}

function validateReferenceRule(db: Database, rule: ReferenceRule): void {
  const orphan = db.query(`
    SELECT 1 FROM ${quoteIdentifier(rule.fromTable)} AS source
    LEFT JOIN ${quoteIdentifier(rule.toTable)} AS target
      ON target.${quoteIdentifier(rule.toColumn)} = source.${quoteIdentifier(rule.fromColumn)}
    WHERE source.${quoteIdentifier(rule.fromColumn)} IS NOT NULL
      ${rule.sourceFilter ? `AND ${rule.sourceFilter}` : ""}
      AND target.${quoteIdentifier(rule.toColumn)} IS NULL
    LIMIT 1
  `).get();
  if (orphan) {
    throw new Error(`agent_btcc_migration_reference_check_failed:${rule.name}`);
  }
}

function copyAndValidateTable(
  source: Database | undefined,
  target: Database,
  table: string,
): AgentBtccMigrationTableReceipt {
  if (!source || !tableExists(source, table)) {
    return tableReceipt(target, table, tableColumns(target, table));
  }
  const sourcePrimaryKey = primaryKeyColumns(source, table);
  const targetPrimaryKey = primaryKeyColumns(target, table);
  if (JSON.stringify(sourcePrimaryKey) !== JSON.stringify(targetPrimaryKey)) {
    throw new Error(`agent_btcc_migration_primary_key_mismatch:${table}`);
  }
  const sourceColumns = tableColumns(source, table);
  const targetColumnSet = new Set(tableColumns(target, table));
  const columns = sourceColumns.filter((column) => targetColumnSet.has(column));
  const selected = projectAgentSourceRows(
    source,
    table,
    selectRows(source, table, columns),
  );
  if (selected.length > 0) {
    const names = columns.map(quoteIdentifier).join(", ");
    const placeholders = columns.map(() => "?").join(", ");
    const insert = target.query(
      `INSERT INTO ${quoteIdentifier(table)} (${names}) VALUES (${placeholders})`,
    );
    for (const row of selected) insert.run(...columns.map((column) => row[column]));
  }
  const sourceReceipt = receiptForRows(table, columns, selected);
  const targetReceipt = tableReceipt(target, table, columns);
  if (sourceReceipt.rowCount !== targetReceipt.rowCount ||
    sourceReceipt.contentSha256 !== targetReceipt.contentSha256) {
    throw new Error(`agent_btcc_migration_table_mismatch:${table}`);
  }
  return targetReceipt;
}

function tableReceipt(
  db: Database,
  table: string,
  columns: string[],
): AgentBtccMigrationTableReceipt {
  return receiptForRows(table, columns, selectRows(db, table, columns));
}

function receiptForRows(
  table: string,
  columns: string[],
  rows: Record<string, CopyableValue>[],
): AgentBtccMigrationTableReceipt {
  const digest = createHash("sha256");
  for (const row of rows) {
    digest.update(JSON.stringify(columns.map((column) => encodeValue(row[column]))));
    digest.update("\n");
  }
  return { name: table, rowCount: rows.length, contentSha256: digest.digest("hex") };
}

function projectAgentSourceRows(
  source: Database,
  table: string,
  rows: Record<string, CopyableValue>[],
): Record<string, CopyableValue>[] {
  if (table === "btcc_checkpoints") {
    const activeLegacy = rows.find((row) =>
      row.kind !== "runtime" && row.is_active === 1,
    );
    if (activeLegacy) {
      throw new Error("agent_btcc_migration_active_legacy_checkpoint");
    }
    return rows.filter((row) => row.kind === "runtime");
  }
  if (table === "btcc_state_claims") {
    const runtimeCheckpointIds = new Set(
      source.query<{ checkpoint_id: string }, []>(`
        SELECT checkpoint_id FROM btcc_checkpoints WHERE kind = 'runtime'
      `).all().map((row) => row.checkpoint_id),
    );
    const activeLegacy = rows.find((row) =>
      !runtimeCheckpointIds.has(String(row.checkpoint_id)) && row.status === "active",
    );
    if (activeLegacy) {
      throw new Error("agent_btcc_migration_active_legacy_claim");
    }
    return rows.filter((row) => runtimeCheckpointIds.has(String(row.checkpoint_id)));
  }
  if (table === "btcc_turns") {
    return rows.map((row) => {
      if (row.final_disposition !== "deferred") return row;
      if (row.semantic_state !== "delivered") {
        throw new Error("agent_btcc_migration_invalid_deferred_turn");
      }
      return { ...row, final_disposition: "completed" };
    });
  }
  return rows;
}

function selectRows(
  db: Database,
  table: string,
  columns: string[],
): Record<string, CopyableValue>[] {
  const order = primaryKeyColumns(db, table);
  const orderSql = order.length > 0 ? order.map(quoteIdentifier).join(", ") : "rowid";
  return db.query<Record<string, CopyableValue>, []>(`
    SELECT ${columns.map(quoteIdentifier).join(", ")}
    FROM ${quoteIdentifier(table)} ORDER BY ${orderSql}
  `).all();
}

function encodeValue(value: CopyableValue): unknown {
  if (value instanceof Uint8Array) return { bytes: Buffer.from(value).toString("base64") };
  if (typeof value === "bigint") return { bigint: value.toString() };
  return value;
}

function tableColumns(db: Database, table: string): string[] {
  return db.query<TableInfo, []>(`PRAGMA table_xinfo(${quoteIdentifier(table)})`).all()
    .filter((column) => !column.hidden)
    .map((column) => column.name);
}

function primaryKeyColumns(db: Database, table: string): string[] {
  return db.query<TableInfo, []>(`PRAGMA table_info(${quoteIdentifier(table)})`).all()
    .filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map((column) => column.name);
}

function btccTableNames(db: Database): string[] {
  return db.query<{ name: string }, []>(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name LIKE 'btcc_%' ORDER BY name
  `).all().map((row) => row.name);
}

function tableExists(db: Database, table: string): boolean {
  return Boolean(db.query<{ present: number }, [string]>(`
    SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?
  `).get(table));
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
