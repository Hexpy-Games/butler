//! Reads delegation rows, including rows written before packets and dispatch
//! intents were typed records.

use rusqlite::{OptionalExtension, Params};
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

fn decode(raw: RawDelegation) -> Result<StoredSubsessionDelegation, serde_json::Error> {
    let mut packet: Value = serde_json::from_str(&raw.packet_json)?;
    upgrade_legacy_packet(&mut packet, &raw.child_session_id);
    let packet: SubsessionPacket = serde_json::from_value(packet)?;
    let dispatch_intent = raw
        .dispatch_intent_json
        .map(|json| serde_json::from_str(&json))
        .transpose()?;
    Ok(StoredSubsessionDelegation {
        relation_id: raw.relation_id,
        delegation_id: raw.delegation_id,
        task_id: raw.task_id,
        parent_session_id: raw.parent_session_id,
        parent_turn_id: raw.parent_turn_id,
        child_session_id: raw.child_session_id,
        child_turn_id: raw.child_turn_id,
        root_work_id: raw.root_work_id,
        packet,
        dispatch_intent,
        anchor_message_id: raw.anchor_message_id,
        ordinal: raw.ordinal,
        safe_title: raw.safe_title,
        created_at: raw.created_at,
    })
}

/// Fills the packet fields that only later packets recorded: the child role
/// (named by its session id prefix) and the access mode (the legacy
/// `access_and_budget_policy`, else implied by the execution mode).
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
        let policy_access = object
            .get("access_and_budget_policy")
            .and_then(|policy| policy.get("access_mode"))
            .filter(|access| access.is_string());
        let access = match policy_access {
            Some(access) => access.clone(),
            None if object.get("execution_mode").and_then(Value::as_str) == Some("read_only") => {
                "read_only".into()
            }
            None => "full_access".into(),
        };
        object.insert("access_mode".into(), access);
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
            decode(raw).map_err(|error| {
                StorageError::new(
                    StorageCode::SubsessionPacketInvalid,
                    "Subsession delegation is undecodable",
                )
                .with_source(error)
            })
        })
        .transpose()
}

/// The delegations matching `filter` (a `WHERE ... ORDER BY ...` tail). A row
/// that cannot be decoded is skipped, so one bad row never hides the rest.
pub(super) fn list(
    db: &rusqlite::Connection,
    filter: &str,
    params: impl Params,
) -> Result<Vec<StoredSubsessionDelegation>, StorageError> {
    let mut statement = db
        .prepare(&format!("{SELECT} {filter}"))
        .map_err(StorageError::sqlite)?;
    let raws = statement
        .query_map(params, raw_row)
        .map_err(StorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(StorageError::sqlite)?;
    Ok(raws.into_iter().filter_map(decode_or_skip).collect())
}

fn decode_or_skip(raw: RawDelegation) -> Option<StoredSubsessionDelegation> {
    let relation_id = raw.relation_id.clone();
    decode(raw)
        .inspect_err(|error| {
            // Only the relation id and the error class: never row content.
            eprintln!(
                "[native-btcc] skipped undecodable subsession delegation relation={relation_id} class={:?}",
                error.classify()
            );
        })
        .ok()
}
