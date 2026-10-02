//! Reads delegation rows, including rows written before packets and dispatch
//! intents were typed records.

use rusqlite::{OptionalExtension, Params, params};
use serde_json::Value;

use super::{SELECT, StoredSubsessionDelegation, SubsessionPacket};
use crate::btcc::{StorageCode, StorageError};

/// A delegation row as stored: the packet and dispatch intent still JSON text.
struct RawDelegation {
    relation_id: String,
    delegation_id: String,
    task_id: String,
    parent_session_id: String,
    parent_turn_id: String,
    child_session_id: String,
    child_turn_id: String,
    root_work_id: String,
    packet_json: String,
    dispatch_intent_json: Option<String>,
    anchor_message_id: String,
    ordinal: i64,
    safe_title: String,
    created_at: String,
}

fn raw_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawDelegation> {
    Ok(RawDelegation {
        relation_id: row.get(0)?,
        delegation_id: row.get(1)?,
        task_id: row.get(2)?,
        parent_session_id: row.get(3)?,
        parent_turn_id: row.get(4)?,
        child_session_id: row.get(5)?,
        child_turn_id: row.get(6)?,
        root_work_id: row.get(7)?,
        packet_json: row.get(8)?,
        dispatch_intent_json: row.get(9)?,
        anchor_message_id: row.get(10)?,
        ordinal: row.get(11)?,
        safe_title: row.get(12)?,
        created_at: row.get(13)?,
    })
}

fn decode(raw: &RawDelegation) -> Result<StoredSubsessionDelegation, serde_json::Error> {
    let mut packet: Value = serde_json::from_str(&raw.packet_json)?;
    upgrade_legacy_packet(&mut packet, &raw.child_session_id);
    let dispatch_intent = raw
        .dispatch_intent_json
        .as_deref()
        .map(serde_json::from_str)
        .transpose()?;
    Ok(StoredSubsessionDelegation {
        relation_id: raw.relation_id.clone(),
        delegation_id: raw.delegation_id.clone(),
        task_id: raw.task_id.clone(),
        parent_session_id: raw.parent_session_id.clone(),
        parent_turn_id: raw.parent_turn_id.clone(),
        child_session_id: raw.child_session_id.clone(),
        child_turn_id: raw.child_turn_id.clone(),
        root_work_id: raw.root_work_id.clone(),
        packet: serde_json::from_value::<SubsessionPacket>(packet)?,
        dispatch_intent,
        anchor_message_id: raw.anchor_message_id.clone(),
        ordinal: raw.ordinal,
        safe_title: raw.safe_title.clone(),
        created_at: raw.created_at.clone(),
    })
}

/// Fills the packet fields that only later packets recorded: the child role
/// (named by its session id prefix) and the access mode.
fn upgrade_legacy_packet(packet: &mut Value, child_session_id: &str) {
    let Some(object) = packet.as_object_mut() else {
        return;
    };
    if !object.contains_key("child_role") {
        let role = if child_session_id.starts_with("worker-") {
            "worker"
        } else {
            "steward"
        };
        object.insert("child_role".into(), role.into());
    }
    if !object.contains_key("access_mode") {
        let access = legacy_access_mode(object);
        object.insert("access_mode".into(), access);
    }
}

/// The access mode of a packet that predates the field: the legacy
/// `access_and_budget_policy` unless the packet only ever read (the stricter
/// of the two); with no policy, the strictest mode a mutation can run under.
fn legacy_access_mode(packet: &serde_json::Map<String, Value>) -> Value {
    let read_only = packet.get("execution_mode").and_then(Value::as_str) == Some("read_only");
    let policy = packet
        .get("access_and_budget_policy")
        .and_then(|policy| policy.get("access_mode"))
        .filter(|access| access.is_string());
    match policy {
        _ if read_only => "read_only".into(),
        Some(access) => access.clone(),
        None => "ask_first".into(),
    }
}

/// One delegation matching `predicate`.
pub(super) fn read(
    db: &rusqlite::Connection,
    predicate: &str,
    value: &str,
) -> Result<Option<StoredSubsessionDelegation>, StorageError> {
    db.query_row(&format!("{SELECT} WHERE {predicate}"), [value], raw_row)
        .optional()
        .map_err(StorageError::sqlite)?
        .map(|raw| {
            decode(&raw).map_err(|error| {
                StorageError::new(
                    StorageCode::SubsessionPacketInvalid,
                    "Subsession delegation is undecodable",
                )
                .with_source(error)
            })
        })
        .transpose()
}

fn query_raw(
    db: &rusqlite::Connection,
    filter: &str,
    params: impl Params,
) -> Result<Vec<RawDelegation>, StorageError> {
    let mut statement = db
        .prepare(&format!("{SELECT} {filter}"))
        .map_err(StorageError::sqlite)?;
    statement
        .query_map(params, raw_row)
        .map_err(StorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(StorageError::sqlite)
}

/// The delegations matching `filter` (a `WHERE ... ORDER BY ...` tail). A row
/// that cannot be decoded is skipped, so one bad row never hides the rest.
pub(super) fn list(
    db: &rusqlite::Connection,
    filter: &str,
    params: impl Params,
) -> Result<Vec<StoredSubsessionDelegation>, StorageError> {
    Ok(query_raw(db, filter, params)?
        .into_iter()
        .filter_map(|raw| decode_or_report(&raw))
        .collect())
}

/// The delegations waiting to be dispatched. A pending row that cannot be
/// decoded could never be dispatched, so it is closed as a failed result:
/// the parent stops waiting for it and it is not retried.
pub(super) fn pending(
    db: &mut rusqlite::Connection,
) -> Result<Vec<StoredSubsessionDelegation>, StorageError> {
    let mut pending = Vec::new();
    for raw in query_raw(
        db,
        "WHERE d.dispatch_state='pending' ORDER BY r.created_at",
        [],
    )? {
        match decode_or_report(&raw) {
            Some(stored) => pending.push(stored),
            None => close_undecodable(db, &raw)?,
        }
    }
    Ok(pending)
}

fn close_undecodable(
    db: &mut rusqlite::Connection,
    raw: &RawDelegation,
) -> Result<(), StorageError> {
    let tx = db.transaction().map_err(StorageError::sqlite)?;
    tx.execute(
        "INSERT OR IGNORE INTO btcc_steward_results (result_id,relation_id,task_id,child_session_id,child_turn_id,status,code,summary,acceptance_evidence_json,changed_artifacts_json,created_at) VALUES (?1,?2,?3,?4,?5,'failed','delegation_context_incomplete','The delegation record is unreadable.','[]','[]',strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
        params![format!("result-unreadable-{}", raw.relation_id), raw.relation_id, raw.task_id, raw.child_session_id, raw.child_turn_id],
    )
    .map_err(StorageError::sqlite)?;
    tx.execute(
        "UPDATE btcc_subsession_delegations SET dispatch_state=NULL WHERE delegation_id=?1",
        [&raw.delegation_id],
    )
    .map_err(StorageError::sqlite)?;
    tx.commit().map_err(StorageError::sqlite)
}

/// The decoded row, or `None` after a diagnostic.
fn decode_or_report(raw: &RawDelegation) -> Option<StoredSubsessionDelegation> {
    decode(raw)
        .inspect_err(|error| {
            // Only the relation id and the error class: never row content.
            butler_core::diagnostic!(
                "[native-btcc] undecodable subsession delegation relation={} class={:?}",
                raw.relation_id,
                error.classify()
            );
        })
        .ok()
}
