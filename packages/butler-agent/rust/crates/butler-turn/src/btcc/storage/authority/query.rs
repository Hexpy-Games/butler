use rusqlite::{Connection, OptionalExtension, Row, ToSql, params};
use serde_json::Value;

use crate::btcc::authority::contracts::{
    AuthorityAdmissionInput, AuthorityError, AuthorityRecord, AuthorityResult,
    AuthorityResumeSource, ConversationPermission,
};

pub(super) const ROW: &str = "SELECT request_id, request_ref, identity_sha256, owner_session_id, \
    source_session_id, source_turn_id, source_call_id, source_work_id, workspace_path, \
    plan_revision_id, action_key, authority_generation, capability, normalized_target, \
    normalized_input_json, model_ref, reasoning_effort, category, reason, executable, \
    command_count, decision, allow_scope, schedule_client_message_id, schedule_input_text, \
    private_alternative_input, outcome, outcome_receipt_json, close_reason, close_scope, \
    closed_at, created_at, updated_at FROM btcc_authority_requests";

pub(super) fn sql(error: rusqlite::Error) -> AuthorityError {
    AuthorityError::storage("sqlite_error", error.to_string()).with_source(error)
}

pub(super) fn retains_approval_claim(db: &Connection, turn_id: &str) -> AuthorityResult<bool> {
    db.query_row(
        "SELECT 1 FROM btcc_turns WHERE turn_id=?1 \
         AND semantic_state IN ('admitted','delivery_committed') \
         AND authority_continuation_json IS NOT NULL LIMIT 1",
        [turn_id],
        |_| Ok(()),
    )
    .optional()
    .map(|row| row.is_some())
    .map_err(sql)
}
fn hydrate(row: &Row<'_>) -> rusqlite::Result<AuthorityRecord> {
    Ok(AuthorityRecord {
        request_id: row.get(0)?,
        request_ref: row.get(1)?,
        identity_sha256: row.get(2)?,
        owner_session_id: row.get(3)?,
        source_session_id: row.get(4)?,
        source_turn_id: row.get(5)?,
        source_call_id: row.get(6)?,
        source_work_id: row.get(7)?,
        workspace_path: row.get(8)?,
        plan_revision_id: row.get(9)?,
        action_key: row.get(10)?,
        authority_generation: row.get(11)?,
        capability: row.get(12)?,
        normalized_target: row.get(13)?,
        normalized_input_json: row.get(14)?,
        model_ref: row.get(15)?,
        reasoning_effort: row.get(16)?,
        category: row.get(17)?,
        reason: row.get(18)?,
        executable: row.get(19)?,
        command_count: row.get(20)?,
        decision: row.get(21)?,
        allow_scope: row.get(22)?,
        schedule_client_message_id: row.get(23)?,
        schedule_input_text: row.get(24)?,
        private_alternative_input: row.get(25)?,
        outcome: row.get(26)?,
        outcome_receipt_json: row.get(27)?,
        close_reason: row.get(28)?,
        close_scope: row.get(29)?,
        closed_at: row.get(30)?,
        created_at: row.get(31)?,
        updated_at: row.get(32)?,
    })
}
fn one(
    db: &Connection,
    sql_text: &str,
    parameters: &[&dyn ToSql],
) -> AuthorityResult<Option<AuthorityRecord>> {
    db.query_row(sql_text, parameters, hydrate)
        .optional()
        .map_err(sql)
}
fn many(
    db: &Connection,
    sql_text: &str,
    parameters: &[&dyn ToSql],
) -> AuthorityResult<Vec<AuthorityRecord>> {
    let mut statement = db.prepare(sql_text).map_err(sql)?;
    statement
        .query_map(parameters, hydrate)
        .map_err(sql)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql)
}
pub(super) fn find(
    db: &Connection,
    column: &str,
    value: &str,
) -> AuthorityResult<Option<AuthorityRecord>> {
    debug_assert!(matches!(column, "request_ref" | "identity_sha256"));
    one(db, &format!("{ROW} WHERE {column} = ?1 LIMIT 1"), &[&value])
}
pub(super) fn find_slot(
    db: &Connection,
    input: &AuthorityAdmissionInput,
    generation: i64,
) -> AuthorityResult<Option<AuthorityRecord>> {
    one(
        db,
        &format!(
            "{ROW} WHERE source_work_id=?1 AND plan_revision_id=?2 AND action_key=?3 \
        AND capability=?4 AND authority_generation=?5 LIMIT 1"
        ),
        &[
            &input.source_work_id,
            &input.plan_revision_id,
            &input.action_key,
            &input.capability,
            &generation,
        ],
    )
}
pub(super) fn has_permission(db: &Connection, grant_ref: &str) -> AuthorityResult<bool> {
    db.query_row(
        "SELECT 1 FROM btcc_conversation_permissions WHERE grant_ref=?1 AND revoked_at IS NULL",
        [grant_ref],
        |row| row.get::<_, i64>(0),
    )
    .optional()
    .map(|row| row.is_some())
    .map_err(sql)
}
pub(super) fn list_permissions(
    db: &Connection,
    owner: &str,
) -> AuthorityResult<Vec<ConversationPermission>> {
    let mut statement = db.prepare("SELECT grant_ref, owner_session_id, workspace_path, scope_key, title, description, created_at \
        FROM btcc_conversation_permissions WHERE owner_session_id=?1 AND revoked_at IS NULL ORDER BY created_at").map_err(sql)?;
    statement
        .query_map([owner], |row| {
            Ok(ConversationPermission {
                grant_ref: row.get(0)?,
                owner_session_id: row.get(1)?,
                workspace_path: row.get(2)?,
                scope_key: row.get(3)?,
                title: row.get(4)?,
                description: row.get(5)?,
                created_at: row.get(6)?,
            })
        })
        .map_err(sql)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql)
}
pub(super) fn list_pending(db: &Connection, owner: &str) -> AuthorityResult<Vec<AuthorityRecord>> {
    many(
        db,
        &format!(
            "{ROW} WHERE owner_session_id=?1 AND decision='pending' AND close_reason IS NULL \
        AND source_call_id IS NOT NULL AND EXISTS (SELECT 1 FROM btcc_turns turn \
        WHERE turn.turn_id=source_turn_id AND turn.suspension_reason='authority_pending') \
        ORDER BY created_at ASC"
        ),
        &[&owner],
    )
}
pub(super) fn list_decided(db: &Connection) -> AuthorityResult<Vec<AuthorityRecord>> {
    many(
        db,
        &format!(
            "{ROW} WHERE decision IN ('allowed','denied','modified') \
        AND source_call_id IS NOT NULL AND EXISTS (SELECT 1 FROM btcc_turns turn \
        WHERE turn.turn_id=source_turn_id AND turn.suspension_reason='authority_pending') \
        AND EXISTS (SELECT 1 FROM btcc_guided_works work \
        WHERE work.work_id=btcc_authority_requests.source_work_id \
        AND work.session_id=btcc_authority_requests.source_session_id \
        AND work.status IN ('open','blocked')) ORDER BY updated_at ASC"
        ),
        &[],
    )
}
pub(super) fn source_work_eligible(
    db: &Connection,
    session: &str,
    work: &str,
) -> AuthorityResult<bool> {
    let status: Option<String> = db
        .query_row(
            "SELECT status FROM btcc_guided_works \
        WHERE work_id=?1 AND session_id=?2 LIMIT 1",
            params![work, session],
            |row| row.get(0),
        )
        .optional()
        .map_err(sql)?;
    Ok(matches!(status.as_deref(), Some("open" | "blocked")))
}
pub(super) fn resume_source(
    db: &Connection,
    request_ref: &str,
) -> AuthorityResult<Option<AuthorityResumeSource>> {
    let row = db
        .query_row(
            "SELECT turn.session_id, turn.turn_id, turn.trigger_key, turn.original_message_id, \
        turn.original_message, turn.progress_destination_json FROM btcc_turns turn \
        JOIN btcc_authority_requests request ON request.source_turn_id=turn.turn_id \
        WHERE request.request_ref=?1 AND request.close_reason IS NULL \
        AND request.decision IN ('allowed','denied','modified') \
        AND turn.suspension_reason='authority_pending' AND turn.semantic_state='admitted' \
        AND json_extract(turn.authority_continuation_json,'$.requestRef')=request.request_ref",
            [request_ref],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ))
            },
        )
        .optional()
        .map_err(sql)?;
    row.map(
        |(session_id, turn_id, original_event_id, original_message_id, original_message, raw)| {
            let destination = raw
                .map(|json| {
                    serde_json::from_str::<Value>(&json).map_err(|error| {
                        AuthorityError::storage("authority_destination_json", error.to_string())
                            .with_source(error)
                    })
                })
                .transpose()?;
            Ok(AuthorityResumeSource {
                session_id,
                turn_id,
                original_event_id,
                original_message_id,
                original_message,
                destination,
            })
        },
    )
    .transpose()
}
pub(super) fn waiting_source_sessions(db: &Connection) -> AuthorityResult<Vec<String>> {
    let mut statement = db
        .prepare(
            "SELECT DISTINCT session_id FROM btcc_turns \
        WHERE semantic_state='admitted' AND suspension_reason='authority_pending'",
        )
        .map_err(sql)?;
    statement
        .query_map([], |row| row.get(0))
        .map_err(sql)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql)
}
