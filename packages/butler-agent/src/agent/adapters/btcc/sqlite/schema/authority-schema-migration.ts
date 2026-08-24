import type { Database } from "bun:sqlite";
import { BTCC_AUTHORITY_SCHEMA } from "./authority-schema.ts";

/**
 * Removes the obsolete post-admission scheduling writeback columns and adds
 * the bounded operational-close audit columns (including the factual
 * Work-abandonment reason/scope). The rewrite runs inside the caller's single
 * migration transaction, is guarded by `requiresRewrite` so it is idempotent,
 * and copies existing close audit and terminal outcomes verbatim.
 */
export function migrateAuthoritySchema(db: Database): void {
  const definition = tableDefinition(db, "btcc_authority_requests");
  if (!definition || !requiresRewrite(db, definition)) return;

  const legacyTable = "btcc_authority_requests_af02d_legacy";
  db.exec(`ALTER TABLE btcc_authority_requests RENAME TO ${legacyTable}`);
  db.exec("DROP INDEX IF EXISTS idx_btcc_authority_requests_owner_pending");
  db.exec("DROP INDEX IF EXISTS idx_btcc_authority_requests_slot_action");
  db.exec(BTCC_AUTHORITY_SCHEMA);
  const privateAlternative = hasColumn(db, legacyTable, "private_alternative_input")
    ? "private_alternative_input"
    : "NULL";
  // A database already migrated by the operational-close slice can carry
  // non-null bounded close audit; the rewrite must copy those columns exactly
  // instead of replacing them with NULL.
  const closeReason = hasColumn(db, legacyTable, "close_reason")
    ? "close_reason"
    : "NULL";
  const closeScope = hasColumn(db, legacyTable, "close_scope")
    ? "close_scope"
    : "NULL";
  const closedAt = hasColumn(db, legacyTable, "closed_at")
    ? "closed_at"
    : "NULL";
  db.exec(`
    INSERT INTO btcc_authority_requests (
      request_id, request_ref, identity_sha256, owner_session_id,
      source_session_id, source_turn_id, source_work_id, workspace_path,
      plan_revision_id, action_key, authority_generation, capability,
      normalized_target, normalized_input_json, model_ref, reasoning_effort,
      category, reason, executable, command_count, decision,
      schedule_client_message_id, schedule_input_text,
      private_alternative_input, outcome, outcome_receipt_json,
      close_reason, close_scope, closed_at,
      created_at, updated_at
    )
    SELECT request_id, request_ref, identity_sha256, owner_session_id,
      source_session_id, source_turn_id, source_work_id, workspace_path,
      plan_revision_id, action_key, authority_generation, capability,
      normalized_target, normalized_input_json, model_ref, reasoning_effort,
      category, reason, executable, command_count, decision,
      schedule_client_message_id, schedule_input_text,
      ${privateAlternative}, outcome, outcome_receipt_json,
      ${closeReason}, ${closeScope}, ${closedAt},
      created_at, updated_at
    FROM ${legacyTable}
    ORDER BY rowid
  `);
  db.exec(`DROP TABLE ${legacyTable}`);
}

function requiresRewrite(db: Database, definition: string): boolean {
  return hasLegacyDecisionCheck(definition) ||
    hasLegacyOutcomeCheck(definition) ||
    hasColumn(db, "btcc_authority_requests", "schedule_state") ||
    hasColumn(db, "btcc_authority_requests", "schedule_turn_id") ||
    !hasColumn(db, "btcc_authority_requests", "close_reason") ||
    !hasColumn(db, "btcc_authority_requests", "close_scope") ||
    !hasColumn(db, "btcc_authority_requests", "closed_at") ||
    !definition.includes("'session_cancelled'") ||
    !definition.includes("'work_abandoned'");
}

function hasLegacyDecisionCheck(definition: string): boolean {
  return /\bdecision\b/iu.test(definition) && !definition.includes("'modified'");
}

/** Detects the prior current schema whose outcome CHECK omits 'uncertain'. */
function hasLegacyOutcomeCheck(definition: string): boolean {
  return /\boutcome\b/iu.test(definition) && !definition.includes("'uncertain'");
}

function hasColumn(db: Database, table: string, column: string): boolean {
  return db.query<{ name: string }, []>(
    `PRAGMA table_info(${table})`,
  ).all().some((candidate) => candidate.name === column);
}

function tableDefinition(db: Database, name: string): string | null {
  return db.query<{ sql: string | null }, [string]>(`
    SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?
  `).get(name)?.sql ?? null;
}
