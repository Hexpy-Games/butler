use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value};

use crate::btcc::identity::digest;
use crate::btcc::storage::common::{canonical_json, error};
use crate::btcc::storage::{StorageError, StorageResult};

use super::types::{Inbox, kind, object, optional_text_object, text, text_object};
use crate::btcc::StorageCode;

pub(super) fn record_inbound(
    connection: &mut Connection,
    command: &Value,
    hash: &str,
) -> StorageResult<Inbox> {
    let transaction = connection.transaction().map_err(StorageError::sqlite)?;
    let session_id = text(command, "sessionId")?;
    let trigger_key = text(command, "triggerKey")?;
    if let Some(existing) = find_inbox(&transaction, session_id, trigger_key)? {
        if existing.admission_input_hash != hash {
            return Err(error(
                StorageCode::AdmissionKeyConflict,
                "BTCC admission key conflict",
            ));
        }
        transaction.commit().map_err(StorageError::sqlite)?;
        return Ok(existing);
    }
    let inbox_id = digest(&format!("btcc-inbox.v1\0{session_id}\0{trigger_key}"));
    insert_canonical_trigger(&transaction, command)?;
    let command_json = canonical_json(command)?;
    let turn_id = text(command, "turnId")?;
    transaction
        .execute(
            "INSERT INTO btcc_inbound_inbox (inbox_id, session_id, trigger_key, turn_id, \
         admission_input_hash, command_json, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'recorded')",
            params![
                inbox_id,
                session_id,
                trigger_key,
                turn_id,
                hash,
                command_json
            ],
        )
        .map_err(StorageError::sqlite)?;
    transaction.commit().map_err(StorageError::sqlite)?;
    Ok(Inbox {
        inbox_id,
        turn_id: turn_id.to_owned(),
        admission_input_hash: hash.to_owned(),
        status: "recorded".to_owned(),
        command_json,
    })
}

pub(super) fn find_inbox(
    connection: &Connection,
    session_id: &str,
    trigger_key: &str,
) -> StorageResult<Option<Inbox>> {
    connection
        .query_row(
            "SELECT inbox_id, turn_id, admission_input_hash, status, command_json \
         FROM btcc_inbound_inbox WHERE session_id = ?1 AND trigger_key = ?2",
            [session_id, trigger_key],
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
        .map_err(StorageError::sqlite)
}

fn insert_canonical_trigger(connection: &Connection, command: &Value) -> StorageResult<()> {
    match kind(command)? {
        "run" => insert_user_message(connection, command),
        "wake" => insert_wake(connection, command),
        _ => Err(error(
            StorageCode::InvalidTurnCommand,
            "Fresh BTCC command must be run or wake",
        )),
    }
}

fn insert_user_message(connection: &Connection, command: &Value) -> StorageResult<()> {
    let message = object(command, "message")?;
    let message_id = text_object(message, "messageId")?;
    let content = text_object(message, "content")?;
    let existing = connection
        .query_row(
            "SELECT content FROM btcc_messages WHERE message_id = ?1",
            [message_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(StorageError::sqlite)?;
    if let Some(existing) = existing {
        return (existing == content).then_some(()).ok_or_else(|| {
            error(
                StorageCode::CanonicalUserConflict,
                "BTCC canonical user message identity conflict",
            )
        });
    }
    connection.execute(
        "INSERT INTO btcc_messages (message_id, session_id, turn_id, role, content, idempotency_key, created_at) \
         VALUES (?1, ?2, ?3, 'user', ?4, ?5, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        params![message_id, text(command, "sessionId")?, text(command, "turnId")?, content,
            format!("inbound:{}:{}", text(command, "sessionId")?, text(command, "triggerKey")?)],
    ).map_err(StorageError::sqlite)?;
    Ok(())
}

fn insert_wake(connection: &Connection, command: &Value) -> StorageResult<()> {
    let trigger = object(command, "trigger")?;
    let trigger_id = text_object(trigger, "triggerId")?;
    let content = text_object(trigger, "content")?;
    let existing = connection
        .query_row(
            "SELECT content FROM btcc_continuation_triggers WHERE trigger_id = ?1",
            [trigger_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(StorageError::sqlite)?;
    if existing.as_deref().is_some_and(|value| value != content) {
        return Err(error(
            StorageCode::ContinuationTriggerConflict,
            "BTCC continuation trigger identity conflict",
        ));
    }
    if existing.is_none() {
        connection.execute(
            "INSERT INTO btcc_continuation_triggers (trigger_id, session_id, turn_id, source_turn_id, \
             authorization_ref, content, idempotency_key, created_at) VALUES \
             (?1, ?2, ?3, ?4, ?5, ?6, ?7, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
            params![trigger_id, text(command, "sessionId")?, text(command, "turnId")?,
                text_object(trigger, "sourceTurnId")?, text_object(trigger, "authorizationRef")?, content,
                format!("wake:{}:{}", text(command, "sessionId")?, text(command, "triggerKey")?)],
        ).map_err(StorageError::sqlite)?;
    }
    insert_wake_fact(connection, command, trigger)
}

fn insert_wake_fact(
    connection: &Connection,
    command: &Value,
    trigger: &Map<String, Value>,
) -> StorageResult<()> {
    let turn_id = text(command, "turnId")?;
    let identity = (
        text_object(trigger, "triggerId")?,
        text_object(trigger, "sourceTurnId")?,
        text_object(trigger, "authorizationRef")?,
        optional_text_object(trigger, "resultScopeRef")?.unwrap_or(""),
        text_object(trigger, "content")?,
    );
    let existing = connection
        .query_row(
            "SELECT trigger_id, source_turn_id, authorization_ref, result_scope_ref, content \
         FROM btcc_wake_request_facts WHERE turn_id = ?1",
            [turn_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()
        .map_err(StorageError::sqlite)?;
    if let Some(existing) = existing {
        if existing.0 != identity.0
            || existing.1 != identity.1
            || existing.2 != identity.2
            || existing.3 != identity.3
            || existing.4 != identity.4
        {
            return Err(error(
                StorageCode::WakeRequestConflict,
                "BTCC wake request identity conflict",
            ));
        }
        return Ok(());
    }
    let owner = connection
        .query_row(
            "SELECT turn_id FROM btcc_wake_request_facts WHERE trigger_id = ?1",
            [identity.0],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(StorageError::sqlite)?;
    if owner.as_deref().is_some_and(|owner| owner != turn_id) {
        return Err(error(
            StorageCode::WakeTriggerConflict,
            "BTCC wake trigger identity conflict",
        ));
    }
    connection
        .execute(
            "INSERT INTO btcc_wake_request_facts (turn_id, session_id, trigger_key, trigger_id, \
         source_turn_id, authorization_ref, result_scope_ref, content, created_at) VALUES \
         (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
            params![
                turn_id,
                text(command, "sessionId")?,
                text(command, "triggerKey")?,
                identity.0,
                identity.1,
                identity.2,
                identity.3,
                identity.4
            ],
        )
        .map_err(StorageError::sqlite)?;
    Ok(())
}
