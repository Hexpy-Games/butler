use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value};

use super::super::common::{column_exists, error, json, stringify};
use super::super::{StorageError, StorageResult};
use super::events::assert_claim;
use super::normalizer::normalize;
use crate::btcc::turn::{ModelRoundAcceptanceWrite, ModelRoundKey};

pub(in crate::btcc::storage) fn load_acceptance(
    connection: &Connection,
    key: &ModelRoundKey,
) -> StorageResult<Option<Value>> {
    let (checkpoint_id, checkpoint_revision) = checkpoint(key)?;
    assert_checkpoint(connection, &key.turn_id, checkpoint_id, checkpoint_revision)?;
    let row = connection
        .query_row(
            "SELECT normalized_response_json,provider_identity_json FROM \
        btcc_model_round_acceptances WHERE turn_id=?1 AND round_id=?2 AND route_digest=?3 \
        AND candidate_index=?4 AND model_ref=?5 AND checkpoint_id=?6 AND checkpoint_revision=?7",
            params![
                key.turn_id,
                key.round_id,
                key.route_digest,
                key.candidate_index,
                key.model_ref,
                checkpoint_id,
                checkpoint_revision
            ],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)),
        )
        .optional()
        .map_err(StorageError::sqlite)?;
    row.map(|(raw, identity)| {
        let mut value = normalize(&json(&raw, "model_acceptance_json")?)?;
        if let Some(raw) = identity {
            value
                .as_object_mut()
                .ok_or_else(|| {
                    error(
                        "model_response_invalid",
                        "normalized response must be object",
                    )
                })?
                .insert(
                    "providerIdentity".into(),
                    normalize_provider_identity(&json(&raw, "provider_identity_json")?)?,
                );
        }
        Ok(value)
    })
    .transpose()
}

pub(in crate::btcc::storage) fn record_acceptance(
    connection: &mut Connection,
    write: &ModelRoundAcceptanceWrite,
) -> StorageResult<()> {
    let (checkpoint_id, checkpoint_revision) = checkpoint(&write.key)?;
    let tx = connection.transaction().map_err(StorageError::sqlite)?;
    assert_claim(
        &tx,
        &write.binding.turn_id,
        write.binding.expected_revision,
        write.binding.execution_fence,
        &write.binding.claim_id,
    )?;
    let claim_checkpoint = tx
        .query_row(
            "SELECT checkpoint_id,checkpoint_revision FROM btcc_state_claims \
        WHERE claim_id=?1",
            [&write.binding.claim_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, u64>(1)?)),
        )
        .map_err(StorageError::sqlite)?;
    if claim_checkpoint != (checkpoint_id.to_owned(), checkpoint_revision) {
        return Err(error(
            "model_acceptance_claim",
            "BTCC model response acceptance lost exact Turn claim",
        ));
    }
    assert_checkpoint(&tx, &write.key.turn_id, checkpoint_id, checkpoint_revision)?;
    let normalized = normalize(&write.result)?;
    let provider = write
        .result
        .get("providerIdentity")
        .map(stringify)
        .transpose()?;
    let acceptance_id = format!(
        "{}:{}:{}:{}:{}",
        write.key.turn_id,
        write.key.round_id,
        write.key.route_digest,
        write.key.candidate_index,
        write.key.model_ref
    );
    tx.execute(
        "INSERT OR IGNORE INTO btcc_model_round_acceptances (acceptance_id,turn_id,round_id,
        route_digest,candidate_index,checkpoint_id,checkpoint_revision,model_ref,transport_attempt,
        normalized_response_json,provider_identity_json,created_at) VALUES
        (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
        params![
            acceptance_id,
            write.key.turn_id,
            write.key.round_id,
            write.key.route_digest,
            write.key.candidate_index,
            checkpoint_id,
            checkpoint_revision,
            write.key.model_ref,
            write.transport_attempt,
            stringify(&normalized)?,
            provider
        ],
    )
    .map_err(StorageError::sqlite)?;
    let event_id = format!(
        "{}:model.attempt.succeeded:{}:{}:{}:{}",
        write.key.turn_id,
        write.key.round_id,
        write.key.candidate_index,
        write.transport_attempt,
        write.key.model_ref
    );
    tx.execute("INSERT OR IGNORE INTO btcc_model_route_events (event_id,turn_id,route_digest,event_type,
        round_id,candidate_index,transport_attempt,model_ref,error_code,failure_disposition,created_at)
        VALUES (?1,?2,?3,'model.attempt.succeeded',?4,?5,?6,?7,NULL,NULL,
        strftime('%Y-%m-%dT%H:%M:%fZ','now'))",params![event_id,write.key.turn_id,
            write.key.route_digest,write.key.round_id,write.key.candidate_index,
            write.transport_attempt,write.key.model_ref]).map_err(StorageError::sqlite)?;
    project_execution_model(
        &tx,
        &write.key.turn_id,
        &write.key.model_ref,
        normalized.get("providerIdentity"),
    )?;
    tx.commit().map_err(StorageError::sqlite)
}

fn checkpoint(key: &ModelRoundKey) -> StorageResult<(&str, u64)> {
    match (key.checkpoint_id.as_deref(), key.checkpoint_revision) {
        (Some(id), Some(rev)) => Ok((id, rev)),
        _ => Err(error(
            "model_checkpoint_missing",
            "model acceptance requires checkpoint identity",
        )),
    }
}
fn assert_checkpoint(
    connection: &Connection,
    turn_id: &str,
    id: &str,
    revision: u64,
) -> StorageResult<()> {
    let row=connection.query_row("SELECT turn.active_checkpoint_id,checkpoint.checkpoint_id,
        checkpoint.checkpoint_revision,checkpoint.is_active FROM btcc_turns turn LEFT JOIN
        btcc_checkpoints checkpoint ON checkpoint.checkpoint_id=?1 AND checkpoint.turn_id=turn.turn_id
        AND checkpoint.checkpoint_revision=?2 WHERE turn.turn_id=?3",params![id,revision,turn_id],
        |r|Ok((r.get::<_,Option<String>>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,Option<u64>>(2)?,r.get::<_,Option<u8>>(3)?)))
        .optional().map_err(StorageError::sqlite)?;
    if !row.is_some_and(|r| {
        r.0.as_deref() == Some(id)
            && r.1.as_deref() == Some(id)
            && r.2 == Some(revision)
            && r.3 == Some(1)
    }) {
        return Err(error(
            "model_checkpoint_stale",
            "BTCC model response acceptance is not bound to the active checkpoint",
        ));
    }
    Ok(())
}
fn project_execution_model(
    connection: &Connection,
    turn_id: &str,
    model_ref: &str,
    identity: Option<&Value>,
) -> StorageResult<()> {
    let table = connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='turns'",
            [],
            |_| Ok(()),
        )
        .optional()
        .map_err(StorageError::sqlite)?
        .is_some();
    if !table
        || !column_exists(connection, "turns", "execution_controls_json")?
        || !column_exists(connection, "turns", "execution_model_json")?
    {
        return Ok(());
    }
    let controls: Option<String> = connection
        .query_row(
            "SELECT execution_controls_json FROM turns WHERE id=?1",
            [turn_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(StorageError::sqlite)?
        .flatten();
    let Some(requested) = controls
        .as_deref()
        .and_then(|v| serde_json::from_str::<Value>(v).ok())
        .and_then(|v| v.get("model_ref")?.as_str().map(str::to_owned))
    else {
        return Ok(());
    };
    let mut value = Map::new();
    value.insert("requested_model_ref".into(), Value::String(requested));
    value.insert(
        "adapter_effective_model_ref".into(),
        Value::String(model_ref.into()),
    );
    if let Some((provider, reported)) = identity.and_then(|v| {
        Some((
            v.get("provider")?.as_str()?,
            v.get("reportedModel")?.as_str()?,
        ))
    }) {
        value.insert(
            "provider_reported_model_ref".into(),
            Value::String(if reported.contains('/') {
                reported.into()
            } else {
                format!("{provider}/{reported}")
            }),
        );
    }
    connection.execute("UPDATE turns SET execution_model_json=?1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?2",params![stringify(&Value::Object(value))?,turn_id]).map_err(StorageError::sqlite)?;
    Ok(())
}
fn normalize_provider_identity(value: &Value) -> StorageResult<Value> {
    let o = value
        .as_object()
        .ok_or_else(|| error("model_response_invalid", "invalid provider identity"))?;
    let mut n = Map::new();
    for k in ["provider", "configuredModel", "reportedModel"] {
        if !o.get(k).is_some_and(Value::is_string) {
            return Err(error("model_response_invalid", "invalid provider identity"));
        }
        n.insert(k.into(), o[k].clone());
    }
    Ok(Value::Object(n))
}
