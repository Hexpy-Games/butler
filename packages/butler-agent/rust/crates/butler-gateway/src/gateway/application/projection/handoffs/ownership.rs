//! Follow delegated result routing to the turn that consumes its files.
use crate::gateway::application::{sessions::identity::resolve_owner, storage::AppStorageError};
use rusqlite::{Connection, OptionalExtension, params};
use std::{io, path::Path};

#[derive(Clone)]
pub(super) enum Owner {
    Turn(String),
    Child(String, String),
}
pub(super) enum Resolved {
    Turn(String),
    Pending {
        parent: String,
        receipt: Option<(String, String, bool, String)>,
    },
}

fn database(data: &Path) -> io::Result<Connection> {
    Connection::open_with_flags(
        data.join(butler_platform::data_paths::BTCC_DB),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(io::Error::other)
}
pub(super) fn decode(value: serde_json::Value) -> io::Result<Owner> {
    if !value.is_object() {
        return Err(io::Error::other("invalid_handoff_owner"));
    }
    #[derive(serde::Deserialize)]
    struct Record {
        turn: String,
        child_session: Option<String>,
    }
    let record: Record = serde_json::from_value(value).map_err(io::Error::other)?;
    Ok(match record.child_session {
        Some(session) => Owner::Child(session, record.turn),
        None => Owner::Turn(record.turn),
    })
}

pub(super) fn resolve(data: &Path, owner: &Owner) -> io::Result<Option<Resolved>> {
    let (session, turn) = match owner {
        Owner::Turn(turn) => return Ok(Some(Resolved::Turn(turn.clone()))),
        Owner::Child(session, turn) => (session, turn),
    };
    let db = database(data)?;
    let mut session = session.clone();
    let mut turn = turn.clone();
    let mut seen = std::collections::HashSet::new();
    while seen.insert(session.clone()) {
        let relation: Option<(String, String, String, String)> = db.query_row(
            "SELECT r.relation_id,r.parent_session_id,r.parent_turn_id,json_extract(d.packet_json,'$.child_role') FROM btcc_session_relations r JOIN btcc_subsession_delegations d ON d.relation_id=r.relation_id WHERE r.child_session_id=?1",
            [&session], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).optional().map_err(io::Error::other)?;
        let Some((relation, parent_session, parent_turn, role)) = relation else {
            return Ok(None);
        };
        let state: Option<String> = db
            .query_row(
                "SELECT semantic_state FROM btcc_turns WHERE turn_id=?1",
                [&turn],
                |row| row.get(0),
            )
            .optional()
            .map_err(io::Error::other)?;
        if state.is_none_or(|state| state == "cancelled") {
            return Ok(None);
        }
        let result: Option<(String, String)> = db
            .query_row(
                "SELECT result_id,status FROM btcc_subsession_outbox WHERE result_id=?1",
                [butler_turn::btcc::subsession_result_id(&session, &turn)],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(io::Error::other)?;
        if role == "steward" {
            let receipt = result.map(|(result, status)| {
                let client = format!(
                    "subsession-result:{}",
                    butler_turn::btcc::digest_identity(&format!("{relation}\0{result}"))
                );
                (
                    parent_session,
                    crate::gateway::application::admission_identity::canonical_client_id(&client),
                    status == "delivered",
                    format!("work-result:{relation}:{result}"),
                )
            });
            return Ok(Some(Resolved::Pending {
                parent: parent_turn,
                receipt,
            }));
        }
        turn = match result {
            Some((result, _)) => {
                let next = format!(
                    "worker-result-turn-{}",
                    butler_turn::btcc::digest_identity(&result)
                );
                if db
                    .query_row("SELECT 1 FROM btcc_turns WHERE turn_id=?1", [&next], |_| {
                        Ok(())
                    })
                    .optional()
                    .map_err(io::Error::other)?
                    .is_some()
                {
                    next
                } else {
                    parent_turn
                }
            }
            None => parent_turn,
        };
        session = parent_session;
    }
    Err(io::Error::other("invalid_handoff_owner"))
}

fn state(db: &Connection, turn: &str) -> Result<Option<(String, bool)>, AppStorageError> {
    db.query_row(
        "SELECT state,retryable FROM turns WHERE id=?1",
        [turn],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
    .map_err(AppStorageError::sqlite)
}
fn final_state(state: &(String, bool)) -> bool {
    matches!(state.0.as_str(), "delivered" | "failed" | "cancelled")
        || state.0 == "runtime_fault" && !state.1
}
pub(super) fn expired(db: &Connection, owner: Option<Resolved>) -> Result<bool, AppStorageError> {
    let Some(owner) = owner else { return Ok(true) };
    match owner {
        Resolved::Turn(turn) => Ok(state(db, &turn)?.is_none_or(|state| final_state(&state))),
        Resolved::Pending { parent, receipt } => {
            let Some(parent) = state(db, &parent)? else {
                return Ok(true);
            };
            if parent.0 != "delivered" && final_state(&parent) {
                return Ok(true);
            }
            let Some((session, client, submitted, source)) = receipt else {
                return Ok(false);
            };
            if let Some(expired) = initiated_result_expired(db, &source)? {
                return Ok(expired);
            }
            let Some(chat) = resolve_owner(db, &session)? else {
                return Ok(true);
            };
            let queued: Option<(Option<String>, String)> = db.query_row(
                "SELECT turn_id,state FROM session_queued_messages WHERE chat_id=?1 AND client_message_id=?2",
                params![chat,client], |row| Ok((row.get(0)?,row.get(1)?))).optional().map_err(AppStorageError::sqlite)?;
            match queued {
                Some((Some(turn), _)) => {
                    Ok(state(db, &turn)?.is_none_or(|state| final_state(&state)))
                }
                Some((None, status)) => Ok(matches!(status.as_str(), "failed" | "cancelled")),
                None => Ok(submitted),
            }
        }
    }
}

/// A held completion owns its files until its consuming turn materializes them.
fn initiated_result_expired(
    db: &Connection,
    source: &str,
) -> Result<Option<bool>, AppStorageError> {
    let row: Option<(String, Option<String>)> = db
        .query_row(
            "SELECT state,message_id FROM app_initiated_messages WHERE source_key=?1",
            [source],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?;
    let Some((status, message)) = row else {
        return Ok(None);
    };
    if status == "held" {
        return Ok(Some(false));
    }
    if status == "failed" {
        return Ok(Some(true));
    }
    let Some(message) = message else {
        return Ok(None);
    };
    let turn: Option<String> = db
        .query_row("SELECT turn_id FROM messages WHERE id=?1", [message], |r| {
            r.get(0)
        })
        .optional()
        .map_err(AppStorageError::sqlite)?
        .flatten();
    turn.map(|turn| state(db, &turn).map(|s| s.is_none_or(|s| final_state(&s))))
        .transpose()
        .map(|expired| Some(expired.unwrap_or(true)))
}
