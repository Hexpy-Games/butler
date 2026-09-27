use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde_json::Value;

use super::super::common::{error, json as parse_json, stringify};
use super::super::{StorageError, StorageResult};
use crate::btcc::StorageCode;
use crate::btcc::turn::{
    AttemptHistory, FailureDisposition, FailureRecord, ModelRoundKey, ModelRouteEvent,
    ModelRouteEventKind, ModelRouteEventWrite, RouteEventStatus,
};

/// Records a model-route event under the turn claim. A replayed attempt start
/// is not recorded again: it reports whether the attempt already ended or was
/// interrupted by a restart (then recorded as abandoned).
pub(in crate::btcc::storage) fn record_event(
    connection: &mut Connection,
    write: &ModelRouteEventWrite,
) -> StorageResult<RouteEventStatus> {
    let tx = connection.transaction().map_err(StorageError::sqlite)?;
    let binding = &write.binding;
    assert_claim(
        &tx,
        &binding.turn_id,
        binding.expected_revision,
        binding.execution_fence,
        &binding.claim_id,
    )?;
    let row = EventRow {
        turn_id: &binding.turn_id,
        route_digest: route_digest(&tx, write)?,
        created_at: tx
            .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| {
                row.get(0)
            })
            .map_err(StorageError::sqlite)?,
        event: &write.event,
    };
    if write.event.kind == ModelRouteEventKind::AttemptStarted
        && let Some(status) = replayed_start(&tx, &row)?
    {
        tx.commit().map_err(StorageError::sqlite)?;
        return Ok(status);
    }
    row.insert(&tx, write.event.kind, &row.event_id())?;
    if !binding.route.is_null() {
        persist_route(&tx, write)?;
    }
    tx.commit().map_err(StorageError::sqlite)?;
    Ok(RouteEventStatus::Recorded)
}

/// One `btcc_model_route_events` row being written.
struct EventRow<'a> {
    turn_id: &'a str,
    route_digest: String,
    created_at: String,
    event: &'a ModelRouteEvent,
}

impl EventRow<'_> {
    fn event_id(&self) -> String {
        let event = self.event;
        format!(
            "{}:{}:{}:{}:{}:{}",
            self.turn_id,
            event.kind.as_str(),
            event.round_id,
            event.candidate_index,
            event.transport_attempt.unwrap_or(0),
            event.model_ref
        )
    }

    fn insert(
        &self,
        tx: &Transaction<'_>,
        kind: ModelRouteEventKind,
        event_id: &str,
    ) -> StorageResult<()> {
        let event = self.event;
        let failure = event.failure.as_ref();
        tx.execute(
            "INSERT OR IGNORE INTO btcc_model_route_events (event_id, turn_id, route_digest, \
            event_type, round_id, candidate_index, transport_attempt, model_ref, error_code, \
            failure_disposition, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![
                event_id,
                self.turn_id,
                self.route_digest,
                kind.as_str(),
                event.round_id,
                event.candidate_index,
                event.transport_attempt,
                event.model_ref,
                failure.map(|failure| failure.error_code.as_str()),
                failure.map(|failure| failure.disposition.as_str()),
                self.created_at
            ],
        )
        .map_err(StorageError::sqlite)?;
        Ok(())
    }
}

/// The route digest of the written route, else of the persisted one.
fn route_digest(tx: &Transaction<'_>, write: &ModelRouteEventWrite) -> StorageResult<String> {
    if let Some(digest) = write.binding.route.get("routeDigest").and_then(Value::as_str) {
        return Ok(digest.to_owned());
    }
    let route_raw: Option<String> = tx
        .query_row(
            "SELECT route_state_json FROM btcc_turns WHERE turn_id=?1",
            [&write.binding.turn_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(StorageError::sqlite)?
        .flatten();
    Ok(route_raw
        .as_deref()
        .and_then(|raw| {
            parse_json(raw, StorageCode::ModelRouteInvalid)
                .ok()?
                .get("routeDigest")?
                .as_str()
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "unknown".to_owned()))
}

/// The status of an attempt start that was already recorded, or `None` for a
/// first start.
fn replayed_start(
    tx: &Transaction<'_>,
    row: &EventRow<'_>,
) -> StorageResult<Option<RouteEventStatus>> {
    let event_id = row.event_id();
    let exists = tx
        .query_row(
            "SELECT 1 FROM btcc_model_route_events WHERE event_id=?1",
            [&event_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(StorageError::sqlite)?
        .is_some();
    if !exists {
        return Ok(None);
    }
    let event = row.event;
    let terminal: Option<String> = tx
        .query_row(
            "SELECT event_type FROM btcc_model_route_events WHERE turn_id=?1 AND round_id=?2 \
             AND candidate_index=?3 AND transport_attempt=?4 AND model_ref=?5 AND event_type IN \
             ('model.attempt.failed','model.attempt.succeeded','model.attempt.abandoned_after_restart') \
             ORDER BY created_at DESC LIMIT 1",
            params![
                row.turn_id,
                event.round_id,
                event.candidate_index,
                event.transport_attempt.unwrap_or(0),
                event.model_ref
            ],
            |row| row.get(0),
        )
        .optional()
        .map_err(StorageError::sqlite)?;
    match terminal.as_deref().map(ModelRouteEventKind::parse) {
        Some(Some(ModelRouteEventKind::AttemptAbandonedAfterRestart)) => {
            Ok(Some(RouteEventStatus::AbandonedAfterRestart))
        }
        Some(_) => Ok(Some(RouteEventStatus::AlreadyTerminal)),
        None => {
            row.insert(
                tx,
                ModelRouteEventKind::AttemptAbandonedAfterRestart,
                &format!("{event_id}:abandoned_after_restart"),
            )?;
            Ok(Some(RouteEventStatus::AbandonedAfterRestart))
        }
    }
}

/// Replaces the persisted route state under the turn's revision and fence.
fn persist_route(tx: &Transaction<'_>, write: &ModelRouteEventWrite) -> StorageResult<()> {
    let binding = &write.binding;
    let changed = tx
        .execute(
            "UPDATE btcc_turns SET route_state_json=?1 WHERE turn_id=?2 \
            AND revision=?3 AND execution_fence=?4",
            params![
                stringify(&binding.route)?,
                binding.turn_id,
                binding.expected_revision,
                binding.execution_fence
            ],
        )
        .map_err(StorageError::sqlite)?;
    if changed != 1 {
        return Err(error(
            StorageCode::ModelRouteCas,
            "BTCC model route persistence lost Turn CAS",
        ));
    }
    Ok(())
}

pub(in crate::btcc::storage) fn load_history(
    connection: &Connection,
    key: &ModelRoundKey,
) -> StorageResult<AttemptHistory> {
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
    let mut history = AttemptHistory::default();
    for row in rows {
        let (kind, attempt, code, disposition) = row.map_err(StorageError::sqlite)?;
        match ModelRouteEventKind::parse(&kind) {
            Some(ModelRouteEventKind::AttemptStarted) => history.started.push(attempt),
            Some(ModelRouteEventKind::AttemptSucceeded) => history.succeeded.push(attempt),
            Some(ModelRouteEventKind::AttemptAbandonedAfterRestart) => {
                history.abandoned.push(attempt);
            }
            Some(ModelRouteEventKind::AttemptFailed) => {
                history.failed.push(attempt);
                if let Some(disposition) = disposition.as_deref().and_then(FailureDisposition::parse)
                {
                    history.failed_details.push(FailureRecord {
                        transport_attempt: attempt,
                        error_code: code.unwrap_or_else(|| "provider_unknown_error".into()),
                        disposition,
                    });
                }
            }
            Some(ModelRouteEventKind::FallbackSelected) | None => {}
        }
    }
    Ok(history)
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
            StorageCode::ModelClaimLost,
            "BTCC model route event lost exact Turn claim",
        ));
    }
    Ok(())
}
