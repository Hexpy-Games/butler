use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

use crate::btcc::continuation_budget::{
    TurnContinuationBudgetLimits, continuation_limits_for_model,
    create_turn_continuation_budget_state,
};
use crate::btcc::identity::digest;
use crate::btcc::storage::common::{canonical_json, column_exists, error, stringify};
use crate::btcc::storage::runtime_owner::RuntimeOwner;
use crate::btcc::storage::{StorageError, StorageResult};

use super::types::{AdmissionClaim, Inbox, kind, object, text, text_object};
use crate::btcc::BtccCode;
use crate::btcc::StorageCode;

pub(super) fn construct_turn(
    connection: &mut Connection,
    _owner: &RuntimeOwner,
    inbox: &Inbox,
    claim: &AdmissionClaim,
    limits: Option<TurnContinuationBudgetLimits>,
) -> StorageResult<String> {
    let transaction = connection.transaction().map_err(StorageError::sqlite)?;
    let stored = transaction
        .query_row(
            "SELECT inbox_id, turn_id, admission_input_hash, status, command_json \
         FROM btcc_inbound_inbox WHERE inbox_id=?1",
            [&inbox.inbox_id],
            |row| {
                Ok(Inbox {
                    inbox_id: row.get(0)?,
                    turn_id: row.get(1)?,
                    admission_input_hash: row.get(2)?,
                    status: row.get(3)?,
                    command_json: row.get(4)?,
                })
            },
        )
        .optional()
        .map_err(StorageError::sqlite)?
        .ok_or_else(|| {
            error(
                StorageCode::InboxMissing,
                "BTCC Turn construction lacks its exact Admission claim",
            )
        })?;
    let status = transaction
        .query_row(
            "SELECT status FROM btcc_admission_claims \
        WHERE claim_id = ?1 AND inbox_id = ?2",
            params![claim.claim_id, inbox.inbox_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(StorageError::sqlite)?;
    if status.as_deref() != Some("active") {
        return Err(error(
            StorageCode::ConstructionClaimMissing,
            "BTCC Turn construction lacks its exact Admission claim",
        ));
    }
    let existing = transaction
        .query_row(
            "SELECT inbox_id FROM btcc_turns WHERE turn_id = ?1",
            [&stored.turn_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(StorageError::sqlite)?;
    if existing
        .as_deref()
        .is_some_and(|value| value != inbox.inbox_id)
    {
        return Err(error(
            StorageCode::TurnInboxConflict,
            "BTCC Turn id is already owned by another Admission Inbox",
        ));
    }
    if existing.is_none() {
        insert_initial_turn(&transaction, &inbox.inbox_id, &stored.command_json, limits)?;
    }
    transaction
        .execute(
            "UPDATE btcc_admission_claims SET status = 'consumed' WHERE claim_id = ?1",
            [&claim.claim_id],
        )
        .map_err(StorageError::sqlite)?;
    transaction
        .execute(
            "UPDATE btcc_inbound_inbox SET status = 'constructed' WHERE inbox_id = ?1",
            [&inbox.inbox_id],
        )
        .map_err(StorageError::sqlite)?;
    transaction.commit().map_err(StorageError::sqlite)?;
    Ok(stored.turn_id)
}

fn insert_initial_turn(
    connection: &Connection,
    inbox_id: &str,
    command_json: &str,
    limits: Option<TurnContinuationBudgetLimits>,
) -> StorageResult<()> {
    let command: Value = serde_json::from_str(command_json).map_err(|error| {
        StorageError::new(StorageCode::InvalidTurnCommand, error.to_string()).with_source(error)
    })?;
    let source = if kind(&command)? == "run" {
        object(&command, "message")?
    } else {
        object(&command, "trigger")?
    };
    let context = command
        .get("context")
        .ok_or_else(|| error(StorageCode::InvalidTurnCommand, "missing context"))?;
    let model = object(&command, "modelSelection")?;
    let context_json = canonical_json(context)?;
    let snapshot_json = canonical_json(&json!({"context": context}))?;
    let snapshot_sha = digest(&snapshot_json);
    let snapshot_ref = digest(&format!("btcc-admission-snapshot.v1\0{snapshot_sha}"));
    insert_immutable_record(
        connection,
        &snapshot_ref,
        "admission_snapshot",
        &snapshot_sha,
        &snapshot_json,
    )?;
    let turn_id = text(&command, "turnId")?;
    let checkpoint_id = digest(&format!("btcc-checkpoint.v1\0{turn_id}\0{}\0admitted", 0));
    let stopped = connection
        .query_row(
            "SELECT status FROM btcc_stop_requests WHERE turn_id = ?1",
            [turn_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(StorageError::sqlite)?
        .as_deref()
        == Some("cancelled_before_admission");
    let mut admitted_model = model.clone();
    let route = admitted_model.shift_remove("modelRoute");
    let now_ms = u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| {
                StorageError::new(StorageCode::ClockBeforeEpoch, error.to_string())
                    .with_source(error)
            })?
            .as_millis(),
    )
    .unwrap_or(u64::MAX);
    let budget = limits
        .map(|limits| {
            let context_window = model.get("contextWindowTokens").and_then(Value::as_f64);
            create_turn_continuation_budget_state(
                turn_id.to_owned(),
                continuation_limits_for_model(limits, context_window),
                now_ms,
            )
            .and_then(|state| {
                serde_json::to_value(state).map_err(|error| {
                    crate::btcc::BtccError::detected(
                        BtccCode::ContinuationBudgetJson,
                        error.to_string(),
                    )
                    .with_source(error)
                })
            })
            .and_then(|value| stringify(&value).map_err(crate::btcc::BtccError::from))
            .map_err(|error| {
                StorageError::new(StorageCode::InvalidContinuationBudget, error.message())
            })
        })
        .transpose()?;
    let has_legacy = column_exists(connection, "btcc_turns", "continuation_snapshot_json")?;
    let sql = if has_legacy {
        "INSERT INTO btcc_turns (turn_id, session_id, inbox_id, trigger_key, original_message_id, \
         original_message, admission_snapshot_ref, model_selection_json, route_state_json, \
         continuation_budget_json, context_json, progress_destination_json, semantic_state, \
         active_checkpoint_id, execution_fence, final_disposition, continuation_snapshot_json, revision) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,'[]',0)"
    } else {
        "INSERT INTO btcc_turns (turn_id, session_id, inbox_id, trigger_key, original_message_id, \
         original_message, admission_snapshot_ref, model_selection_json, route_state_json, \
         continuation_budget_json, context_json, progress_destination_json, semantic_state, \
         active_checkpoint_id, execution_fence, final_disposition, revision) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,0)"
    };
    connection
        .execute(
            sql,
            params![
                turn_id,
                text(&command, "sessionId")?,
                inbox_id,
                text(&command, "triggerKey")?,
                if kind(&command)? == "run" {
                    text_object(source, "messageId")?
                } else {
                    text_object(source, "triggerId")?
                },
                text_object(source, "content")?,
                snapshot_ref,
                canonical_json(&Value::Object(admitted_model))?,
                route.as_ref().map(canonical_json).transpose()?,
                budget,
                context_json,
                command
                    .get("progressDestination")
                    .map(canonical_json)
                    .transpose()?,
                if stopped { "cancelled" } else { "admitted" },
                if stopped {
                    None
                } else {
                    Some(checkpoint_id.as_str())
                },
                i32::from(stopped),
                if stopped { Some("cancelled") } else { None }
            ],
        )
        .map_err(StorageError::sqlite)?;
    if !stopped {
        connection.execute("INSERT INTO btcc_checkpoints (checkpoint_id, turn_id, turn_revision, semantic_state, \
            kind, checkpoint_revision, is_active) VALUES (?1, ?2, 0, 'admitted', 'runtime', 1, 1)",
            params![checkpoint_id, turn_id]).map_err(StorageError::sqlite)?;
    }
    Ok(())
}

fn insert_immutable_record(
    connection: &Connection,
    id: &str,
    kind: &str,
    sha: &str,
    content: &str,
) -> StorageResult<()> {
    connection
        .execute(
            "INSERT OR IGNORE INTO btcc_records (record_id, kind, sha256, content_json) \
        VALUES (?1, ?2, ?3, ?4)",
            params![id, kind, sha, content],
        )
        .map_err(StorageError::sqlite)?;
    let stored = connection
        .query_row(
            "SELECT kind, sha256, content_json FROM btcc_records WHERE record_id = ?1",
            [id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .map_err(StorageError::sqlite)?;
    if stored != (kind.to_owned(), sha.to_owned(), content.to_owned()) {
        return Err(error(
            StorageCode::ImmutableRecordConflict,
            format!("Immutable BTCC record conflict: {id}"),
        ));
    }
    Ok(())
}
