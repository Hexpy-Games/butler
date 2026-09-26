mod blockers;
mod support;

use support::*;

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde_json::{Value, json};

use super::{StorageError, StorageResult};
use crate::btcc::StorageCode;
use crate::btcc::identity::{digest, sqlite_stable_json as btcc_stable_json};

const R2_STATES: &[&str] = &[
    "conception_opening",
    "assisted_answer",
    "conception_deliberation",
    "contract_review",
    "planning",
    "planning_review",
    "work_frontier",
    "task_execution",
    "task_review",
    "feedback_conception",
    "feedback_planning",
    "feedback_planning_review",
    "consolidation",
    "reporting",
];
const R3_STATES: &[&str] = &["admitted", "delivery_committed", "delivered", "cancelled"];

fn stable_json(value: &Value) -> StorageResult<String> {
    btcc_stable_json(value)
        .map_err(|error| StorageError::new(StorageCode::CanonicalJson, error.message()))
}

pub(super) struct LegacyTurn {
    turn_id: String,
    session_id: String,
    original_message: String,
    state: String,
    revision: i64,
    fence: i64,
    checkpoint_id: Option<String>,
    route: Option<String>,
    opening_answer: Option<String>,
    managed_state: Option<String>,
    final_payload: Option<String>,
    goal_contract_ref: Option<String>,
    final_dossier_ref: Option<String>,
    outbox_id: Option<String>,
    canonical_message_id: Option<String>,
    final_disposition: Option<String>,
}

pub(super) fn apply(connection: &mut Connection) -> StorageResult<()> {
    let first = connection.transaction().map_err(StorageError::sqlite)?;
    match cutover(&first) {
        Ok(()) => first.commit().map_err(StorageError::sqlite),
        Err(error) if error.code() == "legacy_turn_cutover_cas_conflict" => {
            drop(first);
            let quarantine = connection.transaction().map_err(StorageError::sqlite)?;
            quarantine_after_conflict(&quarantine, &error.message())?;
            quarantine.commit().map_err(StorageError::sqlite)
        }
        Err(error) => Err(error),
    }
}

fn cutover(db: &Transaction<'_>) -> StorageResult<()> {
    let turns = load_turns(db)?;
    let evidence = evidence_turn_ids(db)?;
    let diagnostics = diagnostics(db, &turns, &evidence)?;
    let cutover_at = current_timestamp(db)?;
    record_quarantines(db, &diagnostics, &cutover_at)?;
    for turn in &turns {
        if diagnostics.contains_key(&turn.turn_id) {
            settle_quarantined(db, turn)?;
        }
    }
    for turn in &turns {
        if R2_STATES.contains(&turn.state.as_str())
            && !evidence.contains(&turn.turn_id)
            && !diagnostics.contains_key(&turn.turn_id)
        {
            convert(db, turn, &cutover_at)?;
        }
    }
    Ok(())
}

fn quarantine_after_conflict(db: &Transaction<'_>, conflicted_turn_id: &str) -> StorageResult<()> {
    let turns = load_turns(db)?;
    let cutover_at = current_timestamp(db)?;
    let mut diagnostics = BTreeMap::new();
    for turn in &turns {
        if R2_STATES.contains(&turn.state.as_str()) {
            let detail = if turn.turn_id == conflicted_turn_id {
                format!("Legacy Turn cutover lost its exact CAS: {conflicted_turn_id}")
            } else {
                "Legacy Turn settlement was quarantined after a concurrent cutover conflict."
                    .to_owned()
            };
            diagnostics.insert(
                turn.turn_id.clone(),
                vec![
                    json!({"turnId": turn.turn_id, "code": "cutover_cas_conflict",
                    "semanticState": turn.state, "detail": detail}),
                ],
            );
        }
    }
    record_quarantines(db, &diagnostics, &cutover_at)?;
    for turn in &turns {
        if diagnostics.contains_key(&turn.turn_id) {
            settle_quarantined(db, turn)?;
        }
    }
    Ok(())
}

fn diagnostics(
    db: &Connection,
    turns: &[LegacyTurn],
    evidence: &BTreeSet<String>,
) -> StorageResult<BTreeMap<String, Vec<Value>>> {
    let ids = turns
        .iter()
        .map(|turn| turn.turn_id.as_str())
        .collect::<BTreeSet<_>>();
    let mut found: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for turn_id in evidence {
        if !ids.contains(turn_id.as_str()) {
            push_diagnostic(
                &mut found,
                turn_id,
                "cutover_evidence_turn_missing",
                None,
                "Cutover evidence exists without its authoritative Turn.",
            );
        }
    }
    for turn in turns {
        if !R2_STATES.contains(&turn.state.as_str()) && !R3_STATES.contains(&turn.state.as_str()) {
            push_diagnostic(
                &mut found,
                &turn.turn_id,
                "unknown_semantic_state",
                Some(&turn.state),
                "The Turn state is not a known R2 cutover or R3 preserved state.",
            );
        } else if evidence.contains(&turn.turn_id) && R2_STATES.contains(&turn.state.as_str()) {
            push_diagnostic(
                &mut found,
                &turn.turn_id,
                "cutover_evidence_state_reverted",
                Some(&turn.state),
                "A previously cut over Turn reverted to an R2-only state.",
            );
        } else if evidence.contains(&turn.turn_id) && turn.state == "admitted" {
            push_diagnostic(
                &mut found,
                &turn.turn_id,
                "unsafe_legacy_reentry_evidence",
                Some(&turn.state),
                "An earlier cutover admitted this legacy Turn for model re-entry; it is quarantined to prevent duplicate effects.",
            );
        } else if R2_STATES.contains(&turn.state.as_str()) && has_delivery_authority(db, turn)? {
            push_diagnostic(
                &mut found,
                &turn.turn_id,
                "legacy_delivery_state_conflict",
                Some(&turn.state),
                "An R2-only Turn already owns delivery authority and requires isolated recovery.",
            );
        }
    }
    Ok(found)
}

fn push_diagnostic(
    map: &mut BTreeMap<String, Vec<Value>>,
    turn_id: &str,
    code: &str,
    state: Option<&str>,
    detail: &str,
) {
    let mut value = json!({"turnId": turn_id, "code": code, "detail": detail});
    if let Some(state) = state {
        value["semanticState"] = Value::String(state.to_owned());
    }
    map.entry(turn_id.to_owned()).or_default().push(value);
}

fn record_quarantines(
    db: &Connection,
    diagnostics: &BTreeMap<String, Vec<Value>>,
    at: &str,
) -> StorageResult<()> {
    for (turn_id, reasons) in diagnostics {
        let reason_json = stable_json(&Value::Array(reasons.clone()))?;
        db.execute(
            "INSERT OR IGNORE INTO btcc_r3_legacy_turn_quarantine \
             (turn_id, reason_json, reason_sha256, quarantined_at) VALUES (?1, ?2, ?3, ?4)",
            params![turn_id, reason_json, digest(&reason_json), at],
        )
        .map_err(StorageError::sqlite)?;
    }
    Ok(())
}

fn convert(db: &Connection, turn: &LegacyTurn, at: &str) -> StorageResult<()> {
    let revision = turn.revision + 1;
    let fence = turn.fence + 1;
    let checkpoint_id = digest(&format!(
        "btcc-r3-legacy-cutover-checkpoint.v2\0{}\0{revision}",
        turn.turn_id
    ));
    let content = limitation_message(&turn.original_message);
    let delivery = new_delivery(
        &turn.turn_id,
        revision,
        &content,
        "btcc-canonical-delivery.v1",
    )?;
    let pending = blockers::pending(db, &turn.turn_id, turn.checkpoint_id.as_deref())?;
    blockers::preserve(
        db,
        &turn.turn_id,
        &turn.session_id,
        turn.managed_state.as_deref(),
        &pending,
        at,
    )?;
    let active_checkpoint_revision = turn
        .checkpoint_id
        .as_deref()
        .map(|id| {
            db.query_row(
                "SELECT checkpoint_revision FROM btcc_checkpoints WHERE checkpoint_id = ?1",
                [id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
        })
        .transpose()
        .map_err(StorageError::sqlite)?
        .flatten();
    let evidence = json!({
        "schema": "btcc.r3.legacy-turn-cutover.v2", "turnId": turn.turn_id,
        "source": {"semanticState": turn.state, "turnRevision": turn.revision,
            "executionFence": turn.fence, "activeCheckpointId": turn.checkpoint_id,
            "activeCheckpointRevision": active_checkpoint_revision, "route": turn.route,
            "openingAnswerSha256": optional_digest(turn.opening_answer.as_deref()),
            "managedStateSha256": optional_digest(turn.managed_state.as_deref()),
            "finalPayloadSha256": optional_digest(turn.final_payload.as_deref()),
            "goalContractRef": turn.goal_contract_ref, "finalDossierRef": turn.final_dossier_ref,
            "deliveryOutboxId": turn.outbox_id, "canonicalAssistantMessageId": turn.canonical_message_id,
            "finalDisposition": turn.final_disposition,
            "activeClaimIds": active_ids(db, "btcc_state_claims", "claim_id", &turn.turn_id,
                "status = 'active'")?,
            "pendingInterruptionIds": active_ids(db, "btcc_operational_interruptions", "interruption_id",
                &turn.turn_id, "status IN ('interrupted', 'ready')")?,
            "openContentionIds": active_ids(db, "btcc_ledger_contentions", "contention_id",
                &turn.turn_id, "status != 'closed'")?},
        "target": {"semanticState": "delivery_committed", "turnRevision": revision,
            "executionFence": fence, "checkpointId": checkpoint_id,
            "checkpointRevision": 0, "checkpointKind": "runtime"},
        "safetyBlockers": pending.iter().map(|item| item.public.clone()).collect::<Vec<_>>(),
        "cutoverAt": at,
    });
    let evidence_json = stable_json(&evidence)?;
    insert_delivery(db, &turn.turn_id, revision, &delivery, "pending")?;
    let changed = db.execute(
        "UPDATE btcc_turns SET semantic_state = 'delivery_committed', active_checkpoint_id = ?1, \
         route = 'assisted', final_payload_json = ?2, delivery_outbox_id = ?3, \
         canonical_assistant_message_id = NULL, revision = ?4, execution_fence = ?5, \
         final_disposition = 'completed' WHERE turn_id = ?6 AND semantic_state = ?7 \
         AND revision = ?8 AND execution_fence = ?9 AND active_checkpoint_id IS ?10",
        params![checkpoint_id, delivery.payload_json, delivery.outbox_id, revision, fence,
            turn.turn_id, turn.state, turn.revision, turn.fence, turn.checkpoint_id],
    ).map_err(StorageError::sqlite)?;
    if changed != 1 {
        return Err(StorageError::new(
            StorageCode::LegacyTurnCutoverCasConflict,
            turn.turn_id.clone(),
        ));
    }
    close_legacy_runtime(db, &turn.turn_id, at)?;
    db.execute(
        "INSERT INTO btcc_checkpoints (checkpoint_id, turn_id, turn_revision, \
        semantic_state, kind, checkpoint_revision, active_claim_id, is_active) \
        VALUES (?1, ?2, ?3, 'delivery_committed', 'runtime', 0, NULL, 1)",
        params![checkpoint_id, turn.turn_id, revision],
    )
    .map_err(StorageError::sqlite)?;
    let cutover_id = digest(&format!(
        "btcc-r3-legacy-turn-cutover.v2\0{}\0{}",
        turn.turn_id, turn.revision
    ));
    db.execute("INSERT INTO btcc_r3_legacy_turn_cutovers (cutover_id, turn_id, \
        source_semantic_state, source_turn_revision, source_execution_fence, source_active_checkpoint_id, \
        admitted_checkpoint_id, admitted_turn_revision, admitted_execution_fence, evidence_json, \
        evidence_sha256, cutover_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![cutover_id, turn.turn_id, turn.state, turn.revision, turn.fence, turn.checkpoint_id,
            checkpoint_id, revision, fence, evidence_json, digest(&evidence_json), at])
        .map_err(StorageError::sqlite)?;
    Ok(())
}

fn settle_quarantined(db: &Connection, turn: &LegacyTurn) -> StorageResult<()> {
    let revision = turn.revision + 1;
    let fence = turn.fence + 1;
    let existing = load_outbox(db, &turn.turn_id)?;
    let canonical = existing_canonical(db, turn, existing.as_ref())?;
    let delivery = if let Some(existing) = existing.as_ref() {
        Delivery::from_existing(existing, &turn.turn_id)?
    } else if let Some(message_id) = canonical.as_deref() {
        let content = db
            .query_row(
                "SELECT content FROM btcc_messages WHERE message_id = ?1",
                [message_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(StorageError::sqlite)?
            .unwrap_or_else(|| limitation_message(&turn.original_message));
        new_delivery(
            &turn.turn_id,
            revision,
            &content,
            "btcc-r3-quarantine-delivery.v1",
        )?
        .with_message(message_id)
    } else {
        new_delivery(
            &turn.turn_id,
            revision,
            &limitation_message(&turn.original_message),
            "btcc-r3-quarantine-delivery.v1",
        )?
    };
    let delivered = canonical.is_some();
    if existing.is_none() {
        insert_delivery(
            db,
            &turn.turn_id,
            revision,
            &delivery,
            if delivered { "observed" } else { "pending" },
        )?;
    } else if delivered
        || !matches!(
            existing.as_ref().map(|row| row.status.as_str()),
            Some("pending" | "inserted")
        )
    {
        db.execute(
            "UPDATE btcc_delivery_outbox SET status = ?1 WHERE outbox_id = ?2",
            params![
                if delivered { "observed" } else { "pending" },
                delivery.outbox_id
            ],
        )
        .map_err(StorageError::sqlite)?;
    }
    if let Some(canonical) = canonical.as_deref() {
        db.execute(
            "INSERT OR IGNORE INTO btcc_canonical_deliveries \
             (turn_id, outbox_id, assistant_message_id, inserted_at) VALUES \
             (?1, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
            params![turn.turn_id, delivery.outbox_id, canonical],
        )
        .map_err(StorageError::sqlite)?;
    }
    let checkpoint = (!delivered).then(|| {
        digest(&format!(
            "btcc-r3-quarantine-checkpoint.v1\0{}\0{revision}",
            turn.turn_id
        ))
    });
    let changed = db.execute("UPDATE btcc_turns SET semantic_state = ?1, active_checkpoint_id = ?2, \
        route = 'assisted', final_payload_json = ?3, delivery_outbox_id = ?4, \
        canonical_assistant_message_id = ?5, revision = ?6, execution_fence = ?7, \
        final_disposition = 'completed' WHERE turn_id = ?8 AND semantic_state = ?9 AND revision = ?10 \
        AND execution_fence = ?11 AND active_checkpoint_id IS ?12", params![
        if delivered { "delivered" } else { "delivery_committed" }, checkpoint,
        delivery.payload_json, delivery.outbox_id, canonical, revision, fence, turn.turn_id,
        turn.state, turn.revision, turn.fence, turn.checkpoint_id]).map_err(StorageError::sqlite)?;
    if changed != 1 {
        return Err(StorageError::new(
            StorageCode::LegacyTurnQuarantineCasConflict,
            &turn.turn_id,
        ));
    }
    deactivate_runtime(db, &turn.turn_id)?;
    if let Some(checkpoint) = checkpoint {
        db.execute(
            "INSERT INTO btcc_checkpoints (checkpoint_id, turn_id, turn_revision, semantic_state, \
            kind, checkpoint_revision, active_claim_id, is_active) VALUES (?1, ?2, ?3, \
            'delivery_committed', 'runtime', 0, NULL, 1)",
            params![checkpoint, turn.turn_id, revision],
        )
        .map_err(StorageError::sqlite)?;
    }
    Ok(())
}
