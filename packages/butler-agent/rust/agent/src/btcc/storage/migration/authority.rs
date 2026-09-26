use rusqlite::Connection;

use super::{column_exists, table_definition};
use crate::btcc::storage::schema::authority::AUTHORITY_SCHEMA;

pub(super) fn migrate(db: &Connection) -> rusqlite::Result<()> {
    let Some(definition) = table_definition(db, "btcc_authority_requests")? else {
        return Ok(());
    };
    if !requires_rewrite(db, &definition)? {
        return Ok(());
    }

    let table = "btcc_authority_requests_af02d_legacy";
    db.execute_batch(&format!(
        "ALTER TABLE btcc_authority_requests RENAME TO {table}; \
         DROP INDEX IF EXISTS idx_btcc_authority_requests_owner_pending; \
         DROP INDEX IF EXISTS idx_btcc_authority_requests_slot_action;"
    ))?;
    db.execute_batch(AUTHORITY_SCHEMA)?;

    let private_alternative = source(db, table, "private_alternative_input", "NULL")?;
    let close_reason = source(db, table, "close_reason", "NULL")?;
    let close_scope = source(db, table, "close_scope", "NULL")?;
    let closed_at = source(db, table, "closed_at", "NULL")?;
    let source_call_id = source(db, table, "source_call_id", "NULL")?;
    let allow_scope = source(db, table, "allow_scope", "'once'")?;
    db.execute_batch(&format!(
        "INSERT INTO btcc_authority_requests (request_id, request_ref, identity_sha256, \
         owner_session_id, source_session_id, source_turn_id, source_work_id, workspace_path, \
         plan_revision_id, action_key, authority_generation, capability, normalized_target, \
         normalized_input_json, model_ref, reasoning_effort, category, reason, executable, \
         command_count, decision, schedule_client_message_id, schedule_input_text, \
         private_alternative_input, outcome, outcome_receipt_json, close_reason, close_scope, \
         closed_at, created_at, updated_at, source_call_id, allow_scope) \
         SELECT request_id, request_ref, identity_sha256, owner_session_id, source_session_id, \
         source_turn_id, source_work_id, workspace_path, plan_revision_id, action_key, \
         authority_generation, capability, normalized_target, normalized_input_json, model_ref, \
         reasoning_effort, category, reason, executable, command_count, decision, \
         schedule_client_message_id, schedule_input_text, {private_alternative}, outcome, \
         outcome_receipt_json, {close_reason}, {close_scope}, {closed_at}, created_at, updated_at, \
         {source_call_id}, {allow_scope} FROM {table} ORDER BY rowid; DROP TABLE {table};"
    ))
}

fn requires_rewrite(db: &Connection, definition: &str) -> rusqlite::Result<bool> {
    Ok(
        (definition.contains("decision") && !definition.contains("'modified'"))
            || (definition.contains("outcome") && !definition.contains("'uncertain'"))
            || column_exists(db, "btcc_authority_requests", "schedule_state")?
            || column_exists(db, "btcc_authority_requests", "schedule_turn_id")?
            || !column_exists(db, "btcc_authority_requests", "close_reason")?
            || !column_exists(db, "btcc_authority_requests", "close_scope")?
            || !column_exists(db, "btcc_authority_requests", "closed_at")?
            || !definition.contains("'reviewed_effect'")
            || !definition.contains("'session_cancelled'")
            || !definition.contains("'work_abandoned'"),
    )
}

fn source(
    db: &Connection,
    table: &str,
    column: &'static str,
    fallback: &'static str,
) -> rusqlite::Result<&'static str> {
    Ok(if column_exists(db, table, column)? {
        column
    } else {
        fallback
    })
}
