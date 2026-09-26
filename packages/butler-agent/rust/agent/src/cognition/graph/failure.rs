//! Settle a claimed semantic window under its original nonce.

use chrono::{DateTime, Duration};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

use super::{db_error, jobs};
use crate::cognition::{CognitionError, CognitionResult, graph::ProjectionWindowOwner};

pub(super) fn pinned_input(
    connection: &Connection,
    window: &str,
    nonce: &str,
) -> CognitionResult<crate::cognition::extraction::ExtractInput> {
    let json=connection.query_row("SELECT input_json FROM memory_projection_windows WHERE window_ref=?1 AND owner_nonce=?2 AND state='running'",
        params![window,nonce],|r|r.get::<_,String>(0)).optional().map_err(db_error)?.ok_or_else(changed)?;
    serde_json::from_str(&json)
        .map_err(|e| CognitionError::new("memory_extract_invalid_json", e.to_string()))
}

pub(super) fn disposition(
    connection: &mut Connection,
    owner: ProjectionWindowOwner<'_>,
    kind: &str,
    revised: Option<&crate::cognition::extraction::ExtractInput>,
    now: &str,
    provider_invoked: bool,
) -> CognitionResult<()> {
    let ProjectionWindowOwner {
        job_id: job,
        window_ref: window,
        nonce,
    } = owner;
    let tx = connection.transaction().map_err(db_error)?;
    let row=tx.query_row("SELECT attempt_count,input_sha256,recovery_revision,input_json FROM memory_projection_windows \
        WHERE window_ref=?1 AND job_id=?2 AND owner_nonce=?3 AND state='running' AND output_json IS NULL AND normalized_plan_json IS NULL",
        params![window,job,nonce],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,String>(3)?)))
        .optional().map_err(db_error)?.ok_or_else(changed)?;
    let evidence = json!({"disposition":kind,"warnings":[{"code":kind}],
        "context_recovery":if revised.is_some(){"scheduled"}else{"exhausted_or_unavailable"}});
    let evidence_json = crate::json::stringify(&evidence).map_err(json_error)?;
    tx.execute("INSERT INTO memory_projection_attempts \
        (attempt_ref,window_ref,job_id,attempt_count,state,error_code,input_sha256,provider_evidence_json,recorded_at,attempt_kind,provider_invoked,outcome_known,invocation_ref,recovery_revision) \
        VALUES(?1,?2,?3,?4,'warning',NULL,?5,?6,?7,'validation',?8,1,?9,?10)",
        params![format!("{window}:attempt:{}:disposition",row.0),window,job,row.0,row.1,evidence_json,now,i64::from(provider_invoked),nonce,row.2]).map_err(db_error)?;
    if tx.execute("UPDATE memory_projection_windows SET state='unsupported',error_code=NULL,provider_evidence_json=?1, \
        owner_pid=NULL,owner_nonce=NULL,started_at=NULL,next_attempt_at=NULL WHERE window_ref=?2 AND owner_nonce=?3",
        params![evidence_json,window,nonce]).map_err(db_error)?!=1{return Err(changed())}
    if let Some(next) = revised {
        let previous: crate::cognition::extraction::ExtractInput =
            serde_json::from_str(&row.3).map_err(json_error)?;
        if kind != "needs_context"
            || next.context_expansion != Some(previous.context_expansion.unwrap_or(0.0) + 1.0)
            || next.context_expansion != Some(1.0)
            || next.source_units != previous.source_units
            || next.episode_ref != previous.episode_ref
            || next.revision != previous.revision
            || next.window_ref != previous.window_ref
        {
            return Err(changed());
        }
        let next_json = crate::json::stringify(&serde_json::to_value(next).map_err(json_error)?)
            .map_err(json_error)?;
        let next_sha = crate::cognition::sources::projection_hash_for_graph(vec![
            Value::String("extract-input".into()),
            Value::String(next_json.clone()),
        ])?;
        let recovery = crate::cognition::sources::projection_hash_for_graph(vec![
            json!("memory-context-revision"),
            json!(window),
            json!(row.1),
            json!(next_sha),
        ])?;
        let request = json!({"reason":"adjacent_source_context","prior_recovery_revision":row.2,
            "previous_input_json":row.3,"previous_input_sha256":row.1,"next_input_json":next_json,"next_input_sha256":next_sha});
        tx.execute("INSERT INTO memory_projection_attempts(attempt_ref,window_ref,job_id,attempt_count,state,error_code,input_sha256,recorded_at,attempt_kind,provider_invoked,outcome_known,recovery_revision,recovery_request_json) \
            VALUES(?1,?2,?3,?4,'recovery_requested','memory_extract_needs_context',?5,?6,'recovery',0,1,?7,?8)",
            params![recovery,window,job,row.0,row.1,now,recovery,crate::json::stringify(&request).map_err(json_error)?]).map_err(db_error)?;
        tx.execute("UPDATE memory_projection_windows SET input_json=?1,input_sha256=?2,input_migration_note='adjacent_source_context', \
            recovery_revision=?3,recovery_base_attempt_count=attempt_count,state='pending',error_code=NULL,next_attempt_at=?4 WHERE window_ref=?5",
            params![next_json,next_sha,recovery,now,window]).map_err(db_error)?;
    }
    jobs::refresh_semantic_state(&tx, job, now)?;
    tx.commit().map_err(db_error)
}

pub(super) fn settle(
    connection: &mut Connection,
    owner: ProjectionWindowOwner<'_>,
    code: &str,
    now: &str,
    provider_invoked: bool,
    repair_exhausted: bool,
) -> CognitionResult<()> {
    let ProjectionWindowOwner {
        job_id: job,
        window_ref: window,
        nonce,
    } = owner;
    let tx = connection.transaction().map_err(db_error)?;
    let row=tx.query_row(
        "SELECT state,attempt_count,recovery_revision,input_sha256,output_json,provider_evidence_json,recovery_base_attempt_count \
         FROM memory_projection_windows WHERE window_ref=?1 AND job_id=?2 AND owner_nonce=?3 AND state IN ('running','planned')",
        params![window,job,nonce],|r| Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,Option<String>>(2)?,
            r.get::<_,Option<String>>(3)?,r.get::<_,Option<String>>(4)?,r.get::<_,Option<String>>(5)?,r.get::<_,i64>(6)?)),
    ).optional().map_err(db_error)?.ok_or_else(changed)?;
    let planned = row.0 == "planned";
    let kind = if planned {
        "apply"
    } else if provider_invoked {
        "provider"
    } else {
        "pre_provider"
    };
    let attempt_ref = if planned {
        format!("{window}:attempt:{}:apply-failed", row.1)
    } else {
        format!("{window}:attempt:{}:failed", row.1)
    };
    tx.execute("INSERT OR REPLACE INTO memory_projection_attempts \
        (attempt_ref,window_ref,job_id,attempt_count,state,error_code,input_sha256,output_json,provider_evidence_json,recorded_at,attempt_kind,provider_invoked,outcome_known,invocation_ref,recovery_revision) \
        VALUES(?1,?2,?3,?4,'failed',?5,?6,?7,?8,?9,?10,?11,1,?12,?13)",
        params![attempt_ref,window,job,row.1,code,row.3,if planned {None} else {row.4},
            if planned {None} else {row.5},now,kind,i64::from(provider_invoked && !planned),nonce,row.2]).map_err(db_error)?;
    let attempts: i64 = if planned {
        tx.query_row("SELECT COUNT(*) FROM memory_projection_attempts WHERE window_ref=?1 AND attempt_kind='apply' AND recovery_revision IS ?2",
            params![window,row.2],|r|r.get(0)).map_err(db_error)?
    } else {
        tx.query_row("SELECT COUNT(DISTINCT invocation_ref) FROM memory_projection_attempts WHERE window_ref=?1 AND provider_invoked=1 AND recovery_revision IS ?2",
            params![window,row.2],|r|r.get(0)).map_err(db_error)?
    };
    if planned && code == "memory_extract_candidate_changed" {
        let exhausted = row.1 - row.6 >= 3;
        if tx.execute("UPDATE memory_projection_windows SET state=?1,error_code=?2,next_attempt_at=?3,
            input_json=NULL,input_sha256=NULL,input_migration_note=NULL,output_json=NULL,provider_evidence_json=NULL,normalized_plan_json=NULL,
            owner_pid=NULL,owner_nonce=NULL,started_at=NULL WHERE window_ref=?4 AND job_id=?5 AND owner_nonce=?6",
            params![if exhausted{"failed"}else{"pending"},if exhausted{"memory_projection_attempts_exhausted"}else{code},
                if exhausted{None}else{Some(now)},window,job,nonce]).map_err(db_error)?!=1{return Err(changed())}
    } else {
        let retry_at = if !repair_exhausted && retryable(code) && attempts < 3 {
            Some(retry_at(now, attempts)?)
        } else {
            None
        };
        let state = if retry_at.is_some() {
            if planned { "planned" } else { "pending" }
        } else {
            "failed"
        };
        if tx.execute("UPDATE memory_projection_windows SET state=?1,error_code=?2,next_attempt_at=?3,owner_pid=NULL,owner_nonce=NULL,started_at=NULL \
            WHERE window_ref=?4 AND job_id=?5 AND owner_nonce=?6",params![state,code,retry_at,window,job,nonce]).map_err(db_error)?!=1{return Err(changed())}
    }
    jobs::refresh_semantic_state(&tx, job, now)?;
    tx.commit().map_err(db_error)
}

fn retryable(code: &str) -> bool {
    code.starts_with("memory_extract_invalid_")
        || matches!(
            code,
            "memory_extract_timeout"
                | "memory_extract_provider_failed"
                | "memory_embedding_unavailable"
                | "memory_embedding_queue_full"
                | "memory_write_busy"
                | "memory_vector_io_transient"
        )
}
fn retry_at(now: &str, attempts: i64) -> CognitionResult<String> {
    let parsed = DateTime::parse_from_rfc3339(now)
        .map_err(|_| CognitionError::new("memory_graph_unavailable", "invalid clock"))?;
    Ok(
        (parsed + Duration::milliseconds(if attempts == 1 { 30_000 } else { 120_000 }))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    )
}
fn changed() -> CognitionError {
    CognitionError::new(
        "memory_projection_window_changed",
        "memory_projection_window_changed",
    )
}
fn json_error(error: impl std::fmt::Display) -> CognitionError {
    CognitionError::new("memory_extract_invalid_json", error.to_string())
}
