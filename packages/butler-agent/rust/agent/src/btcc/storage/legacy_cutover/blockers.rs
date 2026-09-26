use std::collections::BTreeSet;

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

use crate::btcc::storage::migration::table_exists;
use crate::btcc::storage::{StorageError, StorageResult};

use super::{digest, stable_json};

#[derive(Clone)]
pub(super) struct Blocker {
    pub(super) public: Value,
    reconciliation: Option<Reconciliation>,
}

#[derive(Clone)]
struct Reconciliation {
    source_occurrence_id: String,
    capability: String,
    target: String,
    input: Value,
    idempotency_key: String,
}

pub(super) fn pending(
    db: &Connection,
    turn_id: &str,
    checkpoint_id: Option<&str>,
) -> StorageResult<Vec<Blocker>> {
    let mut blockers = pending_checkpoint(db, turn_id, checkpoint_id)?;
    if table_exists(db, "btcc_ledger_promotion_outbox").map_err(StorageError::sqlite)? {
        let mut statement = db
            .prepare(
                "SELECT outbox_id FROM btcc_ledger_promotion_outbox \
                 WHERE turn_id = ?1 AND status = 'pending' \
                 ORDER BY committed_turn_revision, outbox_id",
            )
            .map_err(StorageError::sqlite)?;
        for id in statement
            .query_map([turn_id], |row| row.get::<_, String>(0))
            .map_err(StorageError::sqlite)?
        {
            blockers.push(public(
                turn_id,
                "pending_project_ledger_promotion",
                &id.map_err(StorageError::sqlite)?,
                "A Project Ledger promotion Outbox still requires reconciliation.",
            ));
        }
    }
    if table_exists(db, "btcc_guided_turn_work_bindings").map_err(StorageError::sqlite)?
        && table_exists(db, "btcc_guided_effects").map_err(StorageError::sqlite)?
    {
        let mut statement = db
            .prepare(
                "SELECT effect.effect_id, effect.status, effect.capability \
                 FROM btcc_guided_turn_work_bindings binding \
                 JOIN btcc_guided_effects effect ON effect.work_id = binding.work_id \
                 WHERE binding.turn_id = ?1 AND binding.is_current = 1 \
                 AND effect.status IN ('prepared', 'dispatching', 'uncertain') \
                 ORDER BY effect.effect_id",
            )
            .map_err(StorageError::sqlite)?;
        let rows = statement
            .query_map([turn_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(StorageError::sqlite)?;
        for row in rows {
            let (id, status, capability) = row.map_err(StorageError::sqlite)?;
            blockers.push(public(
                turn_id,
                "pending_guided_effect",
                &id,
                &format!(
                    "Guided effect {capability} remains {status} and requires reconciliation."
                ),
            ));
        }
    }
    blockers.sort_by_key(|item| stable_json(&item.public).unwrap_or_default());
    Ok(blockers)
}

fn pending_checkpoint(
    db: &Connection,
    turn_id: &str,
    checkpoint_id: Option<&str>,
) -> StorageResult<Vec<Blocker>> {
    let Some(checkpoint_id) = checkpoint_id else {
        return Ok(Vec::new());
    };
    if !table_exists(db, "btcc_phase_checkpoint_revisions").map_err(StorageError::sqlite)? {
        return Ok(Vec::new());
    }
    let raw = db
        .query_row(
            "SELECT revision.pending_operation_json FROM btcc_checkpoints checkpoint \
             LEFT JOIN btcc_phase_checkpoint_revisions revision \
             ON revision.checkpoint_id = checkpoint.checkpoint_id \
             AND revision.checkpoint_revision = checkpoint.checkpoint_revision \
             WHERE checkpoint.checkpoint_id = ?1 AND checkpoint.is_active = 1",
            [checkpoint_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(StorageError::sqlite)?
        .flatten();
    let Some(raw) = raw else {
        return Ok(Vec::new());
    };
    let value: Value = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(_) => return Ok(vec![unreadable(turn_id, checkpoint_id)]),
    };
    let Some(requests) = value
        .as_object()
        .filter(|record| record.get("kind").and_then(Value::as_str) == Some("operation_requests"))
        .and_then(|record| record.get("requests"))
        .and_then(Value::as_array)
    else {
        return Ok(vec![unreadable(turn_id, checkpoint_id)]);
    };
    let mut blockers = Vec::new();
    for (index, request) in requests.iter().enumerate() {
        let fallback = format!("{checkpoint_id}:request-{}", index + 1);
        let Some(record) = request.as_object() else {
            blockers.push(unreadable(turn_id, &format!("{checkpoint_id}:{index}")));
            continue;
        };
        let request_id = record
            .get("requestId")
            .and_then(Value::as_str)
            .unwrap_or(&fallback);
        if record
            .get("runtimeAdmission")
            .and_then(Value::as_object)
            .and_then(|admission| admission.get("kind"))
            .and_then(Value::as_str)
            == Some("rejected")
        {
            continue;
        }
        match record.get("kind").and_then(Value::as_str) {
            Some("external_effect") => {
                blockers.extend(external_effect(turn_id, request_id, record));
            }
            Some("repository_promotion") => blockers.push(public(
                turn_id,
                "pending_repository_promotion",
                request_id,
                "A legacy repository promotion request has no committed result.",
            )),
            Some(
                "observe"
                | "workspace_artifact_action"
                | "workspace_artifact_observation"
                | "review_validation"
                | "turn_local_effect",
            ) => {}
            _ => blockers.push(unreadable(turn_id, request_id)),
        }
    }
    Ok(blockers)
}

fn external_effect(
    turn_id: &str,
    request_id: &str,
    request: &serde_json::Map<String, Value>,
) -> Vec<Blocker> {
    let capability = request.get("capabilityRef").and_then(Value::as_str);
    let source_target = request.get("targetScopeRef").and_then(Value::as_str);
    let occurrence = request.get("occurrenceKey").and_then(Value::as_str);
    let input = request.get("input").filter(|value| value.is_object());
    let intent = request.get("effectIntentRef").and_then(Value::as_object);
    let intent_id = intent
        .and_then(|value| value.get("id"))
        .and_then(Value::as_str);
    let intent_sha = intent
        .and_then(|value| value.get("sha256"))
        .and_then(Value::as_str);
    let (
        Some(capability),
        Some(source_target),
        Some(occurrence),
        Some(input),
        Some(intent_id),
        Some(intent_sha),
    ) = (
        capability,
        source_target,
        occurrence,
        input,
        intent_id,
        intent_sha,
    )
    else {
        return vec![public(
            turn_id,
            "pending_external_effect",
            request_id,
            "A legacy external effect request has no committed result.",
        )];
    };
    let targets = exact_targets(capability, source_target, input);
    targets
        .into_iter()
        .map(|target| Blocker {
            public: json!({"turnId": turn_id, "kind": "pending_external_effect",
                "referenceId": request_id,
                "detail": "A legacy external effect request has no committed result.",
                "capability": capability, "target": target}),
            reconciliation: Some(Reconciliation {
                source_occurrence_id: digest(&format!(
                    "btcc-r3-legacy-effect-occurrence.v1\0{turn_id}\0{request_id}\0{occurrence}"
                )),
                capability: capability.to_owned(),
                target,
                input: input.clone(),
                idempotency_key: format!("{intent_id}:{intent_sha}:{occurrence}"),
            }),
        })
        .collect()
}

fn exact_targets(capability: &str, source: &str, input: &Value) -> Vec<String> {
    if capability != "project_ledger_update" {
        return vec![source.to_owned()];
    }
    let mut targets = BTreeSet::new();
    for update in input
        .get("updates")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(id) = update.get("id").and_then(Value::as_str) {
            let kind = update.get("kind").and_then(Value::as_str).unwrap_or("*");
            targets.insert(format!("project-ledger:{kind}:{id}"));
        }
    }
    if targets.is_empty() {
        vec![source.to_owned()]
    } else {
        targets.into_iter().collect()
    }
}

pub(super) fn preserve(
    db: &Connection,
    turn_id: &str,
    session_id: &str,
    managed_state: Option<&str>,
    blockers: &[Blocker],
    created_at: &str,
) -> StorageResult<()> {
    let program_id = managed_state
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .and_then(|value| {
            value
                .get("programId")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
    let work_id = current_work(db, turn_id, program_id.as_deref())?;
    for blocker in blockers {
        let Some(item) = &blocker.reconciliation else {
            continue;
        };
        let input_json = stable_json(&item.input)?;
        let blocker_id = digest(&format!(
            "btcc-r3-work-effect-blocker.v1\0{}\0{}",
            item.source_occurrence_id, item.target
        ));
        db.execute(
            "INSERT OR IGNORE INTO btcc_guided_work_effect_blockers \
             (blocker_id, source_turn_id, source_program_id, source_occurrence_id, session_id, \
             work_id, capability, target, input_json, input_sha256, idempotency_key, detail, \
             status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, \
             'A legacy external effect request has no committed result.', 'unresolved', ?12)",
            params![
                blocker_id,
                turn_id,
                program_id,
                item.source_occurrence_id,
                session_id,
                work_id,
                item.capability,
                item.target,
                input_json,
                digest(&input_json),
                item.idempotency_key,
                created_at
            ],
        )
        .map_err(StorageError::sqlite)?;
    }
    if let Some(work_id) = work_id {
        db.execute(
            "UPDATE btcc_guided_work_effect_blockers SET work_id = ?1 \
             WHERE session_id = ?2 AND status = 'unresolved' \
             AND (source_program_id = ?3 OR source_turn_id = ?4)",
            params![work_id, session_id, program_id, turn_id],
        )
        .map_err(StorageError::sqlite)?;
        db.execute(
            "UPDATE btcc_guided_works SET status = 'blocked', \
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
             WHERE work_id = ?1 AND status = 'open' AND EXISTS (SELECT 1 FROM \
             btcc_guided_work_effect_blockers WHERE work_id = ?1 AND status = 'unresolved')",
            [work_id],
        )
        .map_err(StorageError::sqlite)?;
    }
    Ok(())
}

fn current_work(
    db: &Connection,
    turn_id: &str,
    program_id: Option<&str>,
) -> StorageResult<Option<String>> {
    let bound = db
        .query_row(
            "SELECT work_id FROM btcc_guided_turn_work_bindings \
        WHERE turn_id = ?1 AND is_current = 1",
            [turn_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(StorageError::sqlite)?;
    if bound.is_some() || program_id.is_none() {
        return Ok(bound);
    }
    db.query_row(
        "SELECT work_id FROM btcc_guided_work_legacy_imports WHERE legacy_program_id = ?1 \
        ORDER BY imported_at DESC LIMIT 1",
        [program_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(StorageError::sqlite)
}

fn public(turn_id: &str, kind: &str, reference_id: &str, detail: &str) -> Blocker {
    Blocker {
        public: json!({"turnId": turn_id, "kind": kind,
        "referenceId": reference_id, "detail": detail}),
        reconciliation: None,
    }
}

fn unreadable(turn_id: &str, reference_id: &str) -> Blocker {
    public(
        turn_id,
        "pending_operation_unreadable",
        reference_id,
        "A pending legacy operation cannot be classified safely.",
    )
}
