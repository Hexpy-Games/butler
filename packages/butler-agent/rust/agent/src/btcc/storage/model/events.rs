use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value, json};

use super::super::common::{error, json as parse_json, stringify};
use super::super::{StorageError, StorageResult};
use crate::btcc::turn::{ModelRoundKey, ModelRouteEventWrite};

pub(in crate::btcc::storage) fn record_event(
    connection: &mut Connection,
    write: &ModelRouteEventWrite,
) -> StorageResult<Option<Value>> {
    let tx = connection.transaction().map_err(StorageError::sqlite)?;
    assert_claim(
        &tx,
        &write.binding.turn_id,
        write.binding.expected_revision,
        write.binding.execution_fence,
        &write.binding.claim_id,
    )?;
    let event = write
        .event
        .as_object()
        .ok_or_else(|| error("model_event_invalid", "model route event must be an object"))?;
    let event_type = string(event, "type")?;
    let round_id = string(event, "roundId")?;
    let model_ref = string(event, "modelRef")?;
    let candidate = unsigned(event, "candidateIndex")?;
    let attempt = optional_unsigned(event, "transportAttempt")?;
    let route_raw: Option<String> = tx
        .query_row(
            "SELECT route_state_json FROM btcc_turns WHERE turn_id=?1",
            [&write.binding.turn_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(StorageError::sqlite)?
        .flatten();
    let route_digest = write
        .binding
        .route
        .get("routeDigest")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| {
            route_raw.as_deref().and_then(|raw| {
                parse_json(raw, "model_route_invalid")
                    .ok()?
                    .get("routeDigest")?
                    .as_str()
                    .map(str::to_owned)
            })
        })
        .unwrap_or_else(|| "unknown".to_owned());
    let created_at: String = tx
        .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
            row.get(0)
        })
        .map_err(StorageError::sqlite)?;
    let event_id = format!(
        "{}:{event_type}:{round_id}:{candidate}:{}:{model_ref}",
        write.binding.turn_id,
        attempt.unwrap_or(0)
    );
    let mut result = None;
    if event_type == "model.attempt.started" {
        let exists = tx
            .query_row(
                "SELECT 1 FROM btcc_model_route_events WHERE event_id=?1",
                [&event_id],
                |_| Ok(()),
            )
            .optional()
            .map_err(StorageError::sqlite)?
            .is_some();
        if exists {
            let terminal: Option<String> = tx.query_row(
                "SELECT event_type FROM btcc_model_route_events WHERE turn_id=?1 AND round_id=?2 \
                 AND candidate_index=?3 AND transport_attempt=?4 AND model_ref=?5 AND event_type IN \
                 ('model.attempt.failed','model.attempt.succeeded','model.attempt.abandoned_after_restart') \
                 ORDER BY created_at DESC LIMIT 1",
                params![write.binding.turn_id, round_id, candidate, attempt.unwrap_or(0), model_ref],
                |row| row.get(0),
            ).optional().map_err(StorageError::sqlite)?;
            let status = match terminal.as_deref() {
                Some("model.attempt.abandoned_after_restart") => "abandoned_after_restart",
                Some(_) => "already_terminal",
                None => {
                    tx.execute("INSERT OR IGNORE INTO btcc_model_route_events (event_id, turn_id, \
                        route_digest, event_type, round_id, candidate_index, transport_attempt, \
                        model_ref, error_code, failure_disposition, created_at) VALUES \
                        (?1,?2,?3,'model.attempt.abandoned_after_restart',?4,?5,?6,?7,NULL,NULL,?8)",
                        params![format!("{event_id}:abandoned_after_restart"), write.binding.turn_id,
                            route_digest, round_id, candidate, attempt, model_ref, created_at])
                        .map_err(StorageError::sqlite)?;
                    "abandoned_after_restart"
                }
            };
            result = Some(json!({"status": status}));
        }
    }
    if result.is_none() {
        tx.execute(
            "INSERT OR IGNORE INTO btcc_model_route_events (event_id, turn_id, route_digest, \
            event_type, round_id, candidate_index, transport_attempt, model_ref, error_code, \
            failure_disposition, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![
                event_id,
                write.binding.turn_id,
                route_digest,
                event_type,
                round_id,
                candidate,
                attempt,
                model_ref,
                event.get("errorCode").and_then(Value::as_str),
                event.get("failureDisposition").and_then(Value::as_str),
                created_at
            ],
        )
        .map_err(StorageError::sqlite)?;
        if !write.binding.route.is_null() {
            let changed = tx
                .execute(
                    "UPDATE btcc_turns SET route_state_json=?1 WHERE turn_id=?2 \
                AND revision=?3 AND execution_fence=?4",
                    params![
                        stringify(&write.binding.route)?,
                        write.binding.turn_id,
                        write.binding.expected_revision,
                        write.binding.execution_fence
                    ],
                )
                .map_err(StorageError::sqlite)?;
            if changed != 1 {
                return Err(error(
                    "model_route_cas",
                    "BTCC model route persistence lost Turn CAS",
                ));
            }
        }
        result = Some(json!({"status":"recorded"}));
    }
    tx.commit().map_err(StorageError::sqlite)?;
    Ok(result)
}

pub(in crate::btcc::storage) fn load_history(
    connection: &Connection,
    key: &ModelRoundKey,
) -> StorageResult<Value> {
    let mut statement = connection
        .prepare(
            "SELECT event_type, transport_attempt, error_code, \
        failure_disposition FROM btcc_model_route_events WHERE turn_id=?1 AND route_digest=?2 \
        AND round_id=?3 AND candidate_index=?4 AND model_ref=?5 AND transport_attempt IS NOT NULL \
        ORDER BY transport_attempt ASC, created_at ASC",
        )
        .map_err(StorageError::sqlite)?;
    let rows = statement
        .query_map(
            params![
                key.turn_id,
                key.route_digest,
                key.round_id,
                key.candidate_index,
                key.model_ref
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, u32>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .map_err(StorageError::sqlite)?;
    let (mut started, mut failed, mut details, mut succeeded, mut abandoned) =
        (vec![], vec![], vec![], vec![], vec![]);
    for row in rows {
        let (kind, attempt, code, disposition) = row.map_err(StorageError::sqlite)?;
        match kind.as_str() {
            "model.attempt.started" => started.push(attempt),
            "model.attempt.succeeded" => succeeded.push(attempt),
            "model.attempt.abandoned_after_restart" => abandoned.push(attempt),
            "model.attempt.failed" => {
                failed.push(attempt);
                if disposition
                    .as_deref()
                    .is_some_and(|v| matches!(v, "retry" | "advance" | "surface"))
                {
                    details.push(json!({"transportAttempt":attempt,"errorCode":code.unwrap_or_else(||"provider_unknown_error".into()),"disposition":disposition}));
                }
            }
            _ => {}
        }
    }
    let mut value = Map::new();
    value.insert("started".into(), json!(started));
    value.insert("failed".into(), json!(failed));
    if !details.is_empty() {
        value.insert("failedDetails".into(), Value::Array(details));
    }
    value.insert("succeeded".into(), json!(succeeded));
    value.insert("abandoned".into(), json!(abandoned));
    Ok(Value::Object(value))
}

pub(in crate::btcc::storage) fn assert_claim(
    connection: &Connection,
    turn_id: &str,
    revision: u64,
    fence: u64,
    claim_id: &str,
) -> StorageResult<()> {
    let claim=connection.query_row("SELECT turn_id,turn_revision,execution_fence,status FROM btcc_state_claims WHERE claim_id=?1",[claim_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,u64>(1)?,r.get::<_,u64>(2)?,r.get::<_,String>(3)?))).optional().map_err(StorageError::sqlite)?;
    let turn = connection
        .query_row(
            "SELECT revision,execution_fence,semantic_state FROM btcc_turns WHERE turn_id=?1",
            [turn_id],
            |r| {
                Ok((
                    r.get::<_, u64>(0)?,
                    r.get::<_, u64>(1)?,
                    r.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .map_err(StorageError::sqlite)?;
    if !claim.is_some_and(|r| r.0 == turn_id && r.1 == revision && r.2 == fence && r.3 == "active")
        || !turn.is_some_and(|r| {
            r.0 == revision && r.1 == fence && !matches!(r.2.as_str(), "delivered" | "cancelled")
        })
    {
        return Err(error(
            "model_claim_lost",
            "BTCC model route event lost exact Turn claim",
        ));
    }
    Ok(())
}

fn string<'a>(o: &'a Map<String, Value>, key: &str) -> StorageResult<&'a str> {
    o.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| error("model_event_invalid", format!("missing {key}")))
}
fn unsigned(o: &Map<String, Value>, key: &str) -> StorageResult<u64> {
    o.get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| error("model_event_invalid", format!("invalid {key}")))
}
fn optional_unsigned(o: &Map<String, Value>, key: &str) -> StorageResult<Option<u64>> {
    o.get(key)
        .map(|v| {
            v.as_u64()
                .ok_or_else(|| error("model_event_invalid", format!("invalid {key}")))
        })
        .transpose()
}
