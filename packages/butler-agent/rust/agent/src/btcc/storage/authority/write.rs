use rusqlite::{Connection, TransactionBehavior, params};

use crate::btcc::authority::contracts::{
    AuthorityError, AuthorityRecord, AuthorityResult, DecisionWrite, OutcomeWrite,
};

use super::query;

pub(super) fn revoke_permission(
    db: &Connection,
    owner: &str,
    grant_ref: &str,
    now: &str,
) -> AuthorityResult<()> {
    db.execute(
        "UPDATE btcc_conversation_permissions SET revoked_at=?1 \
        WHERE owner_session_id=?2 AND grant_ref=?3 AND revoked_at IS NULL",
        params![now, owner, grant_ref],
    )
    .map_err(query::sql)?;
    Ok(())
}
pub(super) fn insert(db: &mut Connection, record: &AuthorityRecord) -> AuthorityResult<()> {
    let transaction = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(query::sql)?;
    transaction
        .execute(
            "INSERT INTO btcc_authority_requests (
        request_id, request_ref, identity_sha256, owner_session_id,
        source_session_id, source_turn_id, source_work_id, workspace_path,
        plan_revision_id, action_key, authority_generation, capability,
        normalized_target, normalized_input_json, model_ref, reasoning_effort,
        category, reason, executable, command_count, decision,
        schedule_client_message_id, schedule_input_text, private_alternative_input, outcome,
        outcome_receipt_json, close_reason, close_scope, closed_at,
        created_at, updated_at, source_call_id
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
        ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22,
        ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32
      ) ON CONFLICT DO NOTHING",
            params![
                record.request_id,
                record.request_ref,
                record.identity_sha256,
                record.owner_session_id,
                record.source_session_id,
                record.source_turn_id,
                record.source_work_id,
                record.workspace_path,
                record.plan_revision_id,
                record.action_key,
                record.authority_generation,
                record.capability,
                record.normalized_target,
                record.normalized_input_json,
                record.model_ref,
                record.reasoning_effort,
                record.category,
                record.reason,
                record.executable,
                record.command_count,
                record.decision,
                record.schedule_client_message_id,
                record.schedule_input_text,
                record.private_alternative_input,
                record.outcome,
                record.outcome_receipt_json,
                record.close_reason,
                record.close_scope,
                record.closed_at,
                record.created_at,
                record.updated_at,
                record.source_call_id,
            ],
        )
        .map_err(query::sql)?;
    if let Some(call) = record
        .source_call_id
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        let changed = transaction
            .execute(
                "UPDATE btcc_guided_tool_calls SET status='awaiting_authority' \
            WHERE call_id=?1 AND turn_id=?2 AND status IN ('started','awaiting_authority')",
                params![call, record.source_turn_id],
            )
            .map_err(query::sql)?;
        if changed != 1 {
            return Err(AuthorityError::policy("authority_source_call_not_pending"));
        }
    }
    transaction.commit().map_err(query::sql)
}
pub(super) fn decide(
    db: &mut Connection,
    write: DecisionWrite,
) -> AuthorityResult<Option<AuthorityRecord>> {
    let transaction = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(query::sql)?;
    let decision = match write.action.as_str() {
        "allow" => "allowed",
        "deny" => "denied",
        _ => "modified",
    };
    let schedule = match write.action.as_str() {
        "allow" => "Continue the approved operation exactly once.",
        "deny" => "The reviewed command was denied.",
        _ => "Continue with the reviewed alternative.",
    };
    let changed = transaction.execute("UPDATE btcc_authority_requests \
        SET decision=?1, schedule_input_text=?2, allow_scope=?3, \
        private_alternative_input=CASE WHEN ?4='modified' THEN ?5 ELSE private_alternative_input END, \
        updated_at=?6 WHERE request_ref=?7 AND owner_session_id=?8 AND source_session_id=?9 \
        AND decision='pending' AND close_reason IS NULL AND source_call_id IS NOT NULL \
        AND EXISTS (SELECT 1 FROM btcc_turns source \
        WHERE source.turn_id=btcc_authority_requests.source_turn_id \
        AND source.suspension_reason='authority_pending' AND source.semantic_state='admitted' \
        AND json_extract(source.authority_continuation_json,'$.requestRef')=request_ref)",
        params![decision,schedule,if write.permission.is_some(){"conversation"}else{"once"},
            decision,write.alternative_input,write.now,write.request_ref,write.owner_session_id,
            write.source_session_id]).map_err(query::sql)?;
    if changed != 1 {
        transaction.commit().map_err(query::sql)?;
        return Ok(None);
    }
    if let Some(grant) = write.permission {
        transaction.execute("INSERT INTO btcc_conversation_permissions \
            (grant_ref, owner_session_id, workspace_path, scope_key, title, description, created_at) \
            VALUES (?1,?2,?3,?4,?5,?6,?7) \
            ON CONFLICT(grant_ref) DO UPDATE SET revoked_at=NULL, created_at=excluded.created_at",
            params![grant.grant_ref,grant.owner_session_id,grant.workspace_path,grant.scope_key,
                grant.title,grant.description,grant.created_at]).map_err(query::sql)?;
    }
    let stored = query::find(&transaction, "request_ref", &write.request_ref)?;
    transaction.commit().map_err(query::sql)?;
    Ok(stored)
}
pub(super) fn record_outcome(db: &Connection, write: OutcomeWrite) -> AuthorityResult<()> {
    db.execute(
        "UPDATE btcc_authority_requests \
        SET outcome=?1, outcome_receipt_json=COALESCE(?2,outcome_receipt_json), updated_at=?3 \
        WHERE request_ref=?4 AND source_work_id=?5 AND decision='allowed' \
        AND outcome IN ('pending','failed')",
        params![
            write.status,
            write.receipt_json,
            write.now,
            write.request_ref,
            write.source_work_id
        ],
    )
    .map_err(query::sql)?;
    Ok(())
}
