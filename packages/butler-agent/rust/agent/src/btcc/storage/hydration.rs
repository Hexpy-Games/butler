use rusqlite::{Connection, OptionalExtension};

use super::common::{error, json, parse_state};
use super::{StorageError, StorageResult};
use crate::btcc::turn::{
    ContentRef, DeliveryOutbox, DeliveryStatus, ExecutionRoute, FinalPayload, SuspensionReason,
    TurnCheckpoint, TurnRecord, TurnSemanticState,
};
use crate::btcc::{FinalDisposition, ProgressDestination, WakeIdentity};

struct TurnRow {
    turn_id: String,
    session_id: String,
    inbox_id: String,
    trigger_key: String,
    original_message_id: String,
    original_message: String,
    model_selection_json: String,
    route_state_json: Option<String>,
    continuation_budget_json: Option<String>,
    context_json: String,
    progress_destination_json: Option<String>,
    semantic_state: String,
    suspension_reason: Option<String>,
    authority_continuation_json: Option<String>,
    active_checkpoint_id: Option<String>,
    route: Option<String>,
    final_payload_json: Option<String>,
    delivery_outbox_id: Option<String>,
    canonical_assistant_message_id: Option<String>,
    revision: u64,
    execution_fence: u64,
    final_disposition: Option<String>,
}

pub(super) fn find_turn(
    connection: &Connection,
    turn_id: &str,
) -> StorageResult<Option<TurnRecord>> {
    let row = connection
        .query_row(
            "SELECT turn_id, session_id, inbox_id, trigger_key, original_message_id, \
             original_message, model_selection_json, route_state_json, continuation_budget_json, \
             context_json, progress_destination_json, semantic_state, suspension_reason, \
             authority_continuation_json, active_checkpoint_id, route, final_payload_json, \
             delivery_outbox_id, canonical_assistant_message_id, revision, execution_fence, \
             final_disposition FROM btcc_turns WHERE turn_id = ?1",
            [turn_id],
            |row| {
                Ok(TurnRow {
                    turn_id: row.get(0)?,
                    session_id: row.get(1)?,
                    inbox_id: row.get(2)?,
                    trigger_key: row.get(3)?,
                    original_message_id: row.get(4)?,
                    original_message: row.get(5)?,
                    model_selection_json: row.get(6)?,
                    route_state_json: row.get(7)?,
                    continuation_budget_json: row.get(8)?,
                    context_json: row.get(9)?,
                    progress_destination_json: row.get(10)?,
                    semantic_state: row.get(11)?,
                    suspension_reason: row.get(12)?,
                    authority_continuation_json: row.get(13)?,
                    active_checkpoint_id: row.get(14)?,
                    route: row.get(15)?,
                    final_payload_json: row.get(16)?,
                    delivery_outbox_id: row.get(17)?,
                    canonical_assistant_message_id: row.get(18)?,
                    revision: row.get(19)?,
                    execution_fence: row.get(20)?,
                    final_disposition: row.get(21)?,
                })
            },
        )
        .optional()
        .map_err(StorageError::sqlite)?;
    row.map(|row| hydrate(connection, row)).transpose()
}

fn hydrate(connection: &Connection, row: TurnRow) -> StorageResult<TurnRecord> {
    let semantic_state = parse_state(&row.semantic_state)?;
    let checkpoint = load_checkpoint(connection, &row, semantic_state)?;
    let delivery_outbox = load_outbox(connection, row.delivery_outbox_id.as_deref())?;
    let final_payload = row
        .final_payload_json
        .as_deref()
        .map(hydrate_final_payload)
        .transpose()?;
    let turn = TurnRecord {
        wake_identity: load_wake_identity(connection, &row.turn_id)?,
        model_selection: json(&row.model_selection_json, "invalid_model_selection")?,
        model_route: parse_optional_json(row.route_state_json.as_deref(), "invalid_model_route")?,
        continuation_budget: parse_optional_json(
            row.continuation_budget_json.as_deref(),
            "invalid_continuation_budget",
        )?,
        context: json(&row.context_json, "invalid_turn_context")?,
        progress_destination: row
            .progress_destination_json
            .as_deref()
            .map(hydrate_legacy_progress_projection)
            .transpose()?,
        suspension: parse_suspension(row.suspension_reason.as_deref())?,
        authority_continuation: parse_optional_json(
            row.authority_continuation_json.as_deref(),
            "invalid_authority_continuation",
        )?,
        route: parse_route(row.route.as_deref())?,
        final_disposition: parse_disposition(row.final_disposition.as_deref())?,
        turn_id: row.turn_id,
        session_id: row.session_id,
        inbox_id: row.inbox_id,
        trigger_key: row.trigger_key,
        original_message_id: row.original_message_id,
        original_message: row.original_message,
        semantic_state,
        checkpoint,
        final_payload,
        delivery_outbox,
        canonical_assistant_message_id: row.canonical_assistant_message_id,
        revision: row.revision,
        execution_fence: row.execution_fence,
    };
    assert_record(&turn)?;
    Ok(turn)
}

fn parse_optional_json(
    value: Option<&str>,
    code: &'static str,
) -> StorageResult<Option<serde_json::Value>> {
    value.map(|value| json(value, code)).transpose()
}

fn load_checkpoint(
    connection: &Connection,
    row: &TurnRow,
    state: TurnSemanticState,
) -> StorageResult<Option<TurnCheckpoint>> {
    let Some(checkpoint_id) = &row.active_checkpoint_id else {
        return Ok(None);
    };
    let checkpoint = connection
        .query_row(
            "SELECT checkpoint_id, checkpoint_revision, kind, semantic_state \
             FROM btcc_checkpoints WHERE checkpoint_id = ?1 AND turn_id = ?2 AND is_active = 1",
            [checkpoint_id, &row.turn_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, u64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()
        .map_err(StorageError::sqlite)?
        .ok_or_else(|| error("checkpoint_missing", "BTCC R3 active checkpoint is missing"))?;
    if checkpoint.2 != "runtime" || parse_state(&checkpoint.3)? != state {
        return Err(error(
            "checkpoint_mismatch",
            "BTCC R3 checkpoint does not match its Turn",
        ));
    }
    Ok(Some(TurnCheckpoint {
        checkpoint_id: checkpoint.0,
        checkpoint_revision: checkpoint.1,
        semantic_state: state,
    }))
}

fn load_outbox(
    connection: &Connection,
    outbox_id: Option<&str>,
) -> StorageResult<Option<DeliveryOutbox>> {
    let Some(outbox_id) = outbox_id else {
        return Ok(None);
    };
    let row = connection
        .query_row(
            "SELECT outbox_id, payload_id, payload_sha256, expected_message_id, content, status \
         FROM btcc_delivery_outbox WHERE outbox_id = ?1",
            [outbox_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                ))
            },
        )
        .optional()
        .map_err(StorageError::sqlite)?
        .ok_or_else(|| error("outbox_missing", "BTCC R3 delivery Outbox is missing"))?;
    let status = match row.5.as_str() {
        "pending" => DeliveryStatus::Pending,
        "inserted" => DeliveryStatus::Inserted,
        "observed" => DeliveryStatus::Observed,
        _ => {
            return Err(error(
                "outbox_invalid",
                "BTCC R3 delivery Outbox is invalid",
            ));
        }
    };
    Ok(Some(DeliveryOutbox {
        outbox_id: row.0,
        final_payload_ref: ContentRef {
            id: row.1,
            sha256: row.2,
        },
        expected_message_id: row.3,
        content: row.4,
        status,
    }))
}

fn load_wake_identity(
    connection: &Connection,
    turn_id: &str,
) -> StorageResult<Option<WakeIdentity>> {
    connection
        .query_row(
            "SELECT trigger_id, source_turn_id, authorization_ref, result_scope_ref \
         FROM btcc_wake_request_facts WHERE turn_id = ?1",
            [turn_id],
            |row| {
                let scope = row.get::<_, String>(3)?;
                Ok(WakeIdentity {
                    trigger_id: row.get(0)?,
                    source_turn_id: row.get(1)?,
                    authorization_ref: row.get(2)?,
                    result_scope_ref: (!scope.is_empty()).then_some(scope),
                })
            },
        )
        .optional()
        .map_err(StorageError::sqlite)
}

fn hydrate_legacy_progress_projection(value: &str) -> StorageResult<ProgressDestination> {
    let mut destination: ProgressDestination = serde_json::from_str(value)
        .map_err(|error| StorageError::new("invalid_progress_destination", error.to_string()))?;
    // Named compatibility projection: exact stored JSON retains this field.
    destination.app_queue_claim_id = None;
    Ok(destination)
}

pub(super) fn hydrate_final_payload(value: &str) -> StorageResult<FinalPayload> {
    let payload: FinalPayload = serde_json::from_str(value)
        .map_err(|error| StorageError::new("invalid_final_payload", error.to_string()))?;
    if payload.reference.id.is_empty()
        || payload.reference.sha256.is_empty()
        || payload.content_sha256.is_empty()
        || payload.model_identity.as_ref().is_some_and(|identity| {
            !model_ref(&identity.requested_model_ref)
                || !model_ref(&identity.effective_model_ref)
                || identity
                    .provider_reported_model_ref
                    .as_deref()
                    .is_some_and(|value| !model_ref(value))
        })
    {
        return Err(error(
            "invalid_final_payload",
            "BTCC R3 final payload is invalid",
        ));
    }
    Ok(payload)
}

fn model_ref(value: &str) -> bool {
    value.encode_utf16().count() <= 256
        && !value.chars().any(char::is_whitespace)
        && value.split('/').count() == 2
        && value.split('/').all(|part| !part.is_empty())
}

fn parse_suspension(value: Option<&str>) -> StorageResult<Option<SuspensionReason>> {
    match value {
        None => Ok(None),
        Some("authority_pending") => Ok(Some(SuspensionReason::AuthorityPending)),
        Some("waiting_for_worker") => Ok(Some(SuspensionReason::WaitingForWorker)),
        Some(_) => Err(error(
            "invalid_suspension_reason",
            "BTCC suspension reason is invalid",
        )),
    }
}

fn parse_route(value: Option<&str>) -> StorageResult<Option<ExecutionRoute>> {
    match value {
        None => Ok(None),
        Some("direct") => Ok(Some(ExecutionRoute::Direct)),
        Some("assisted") => Ok(Some(ExecutionRoute::Assisted)),
        Some("managed") => Ok(Some(ExecutionRoute::Managed)),
        Some(value) => Err(error(
            "invalid_route",
            format!("BTCC R3 route is invalid: {value}"),
        )),
    }
}

fn parse_disposition(value: Option<&str>) -> StorageResult<Option<FinalDisposition>> {
    match value {
        None => Ok(None),
        Some("completed") => Ok(Some(FinalDisposition::Completed)),
        Some("cancelled") => Ok(Some(FinalDisposition::Cancelled)),
        Some(value) => Err(error(
            "invalid_final_disposition",
            format!("BTCC R3 final disposition is invalid: {value}"),
        )),
    }
}

fn assert_record(turn: &TurnRecord) -> StorageResult<()> {
    let nonterminal = (turn.semantic_state == TurnSemanticState::Admitted
        && turn.suspension.is_none())
        || turn.semantic_state == TurnSemanticState::DeliveryCommitted;
    if nonterminal != turn.checkpoint.is_some() {
        return Err(error(
            "checkpoint_lifecycle_mismatch",
            "BTCC R3 Turn checkpoint does not match lifecycle state",
        ));
    }
    if turn.semantic_state == TurnSemanticState::Admitted {
        if turn.final_payload.is_some() || turn.delivery_outbox.is_some() {
            return Err(error(
                "admitted_has_delivery",
                "Admitted BTCC R3 Turn already has final delivery data",
            ));
        }
        return Ok(());
    }
    if turn.semantic_state == TurnSemanticState::Cancelled {
        return Ok(());
    }
    let matches = turn
        .final_payload
        .as_ref()
        .zip(turn.delivery_outbox.as_ref())
        .is_some_and(|(payload, outbox)| {
            payload.reference == outbox.final_payload_ref && payload.content == outbox.content
        });
    if !matches {
        return Err(error(
            "final_outbox_mismatch",
            "BTCC R3 final payload does not match its Outbox",
        ));
    }
    if turn.semantic_state == TurnSemanticState::DeliveryCommitted
        && turn
            .delivery_outbox
            .as_ref()
            .is_some_and(|outbox| outbox.status == DeliveryStatus::Observed)
    {
        return Err(error(
            "committed_already_observed",
            "BTCC R3 committed delivery is already observed",
        ));
    }
    if turn.semantic_state == TurnSemanticState::Delivered
        && (!turn
            .delivery_outbox
            .as_ref()
            .is_some_and(|outbox| outbox.status == DeliveryStatus::Observed)
            || turn.canonical_assistant_message_id.is_none())
    {
        return Err(error(
            "delivered_unobserved",
            "Delivered BTCC R3 Turn lacks canonical observation",
        ));
    }
    Ok(())
}
