//! Durable semantic-window claim and replay authority.

use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde_json::{Value, json};

use super::{db_error, jobs};
use crate::cognition::{CognitionError, CognitionResult};
use crate::coordination::CognitionProcessStatus;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(in crate::cognition) enum PreviousWindowState {
    Pending,
    Planned,
}

pub(in crate::cognition) struct ClaimedProjectionWindow {
    pub job_id: String,
    pub window_ref: String,
    pub source_refs: Vec<String>,
    pub model: String,
    pub reasoning_effort: String,
    pub previous_state: PreviousWindowState,
    pub output: Option<Value>,
    pub plan: Option<Value>,
    pub owner_nonce: String,
    pub pinned_input: Option<Value>,
}

struct InterruptedProjectionWindow {
    attempt_count: i64,
    recovery_revision: Option<String>,
    input_sha256: Option<String>,
    normalized_plan: Option<String>,
    output_json: Option<String>,
    provider_evidence_json: Option<String>,
}

pub(in crate::cognition) struct ClaimProjectionWindowInput<'a> {
    pub job_id: Option<&'a str>,
    pub now: &'a str,
    pub owner_pid: u32,
    pub owner_nonce: &'a str,
    pub active_owners: &'a HashSet<(String, String, String)>,
    pub process_status: &'a dyn Fn(u64) -> CognitionProcessStatus,
}

pub(super) fn claim(
    connection: &mut Connection,
    input: ClaimProjectionWindowInput<'_>,
) -> CognitionResult<Option<ClaimedProjectionWindow>> {
    let tx = connection.transaction().map_err(db_error)?;
    recover_interrupted(&tx, &input)?;
    let row = select_window(&tx, input.job_id, input.now)?;
    let Some(row) = row else {
        tx.commit().map_err(db_error)?;
        return Ok(None);
    };
    let changed_rows = tx
        .execute(
            "UPDATE memory_projection_windows SET state='running',attempt_count=attempt_count+1,\
         owner_pid=?1,owner_nonce=?2,started_at=?3,next_attempt_at=NULL \
         WHERE window_ref=?4 AND state=?5",
            params![
                input.owner_pid,
                input.owner_nonce,
                input.now,
                row.window_ref,
                row.state
            ],
        )
        .map_err(db_error)?;
    if changed_rows != 1 {
        return Err(changed());
    }
    let attempt = row.attempt_count + 1;
    let running = json!({"state":"running","attempt":attempt-row.recovery_base_attempt_count,
        "owner_pid":input.owner_pid,"started_at":input.now});
    tx.execute(
        "UPDATE memory_projection_jobs SET semantic_graph_state=?1 WHERE job_id=?2",
        params![stringify(&running)?, row.job_id],
    )
    .map_err(db_error)?;
    tx.commit().map_err(db_error)?;
    Ok(Some(ClaimedProjectionWindow {
        job_id: row.job_id,
        window_ref: row.window_ref,
        source_refs: parse(&row.source_refs_json)?,
        model: row.model,
        reasoning_effort: row.reasoning_effort,
        previous_state: if row.state == "planned" {
            PreviousWindowState::Planned
        } else {
            PreviousWindowState::Pending
        },
        output: parse_optional(row.output_json.as_deref())?,
        plan: parse_optional(row.plan_json.as_deref())?,
        owner_nonce: input.owner_nonce.to_owned(),
        pinned_input: parse_optional(row.input_json.as_deref())?,
    }))
}

pub(super) fn pin_input(
    connection: &Connection,
    window_ref: &str,
    owner_nonce: &str,
    input: &Value,
    migration_note: Option<&str>,
) -> CognitionResult<()> {
    let json = stringify(input)?;
    let sha = crate::cognition::sources::projection_hash_for_graph(vec![
        Value::String("extract-input".into()),
        Value::String(json.clone()),
    ])?;
    let changed_rows = connection
        .execute(
            "UPDATE memory_projection_windows SET \
        input_json=COALESCE(input_json,?1),input_sha256=COALESCE(input_sha256,?2),\
        input_migration_note=COALESCE(input_migration_note,?3) \
        WHERE window_ref=?4 AND state='running' AND owner_nonce=?5",
            params![json, sha, migration_note, window_ref, owner_nonce],
        )
        .map_err(db_error)?;
    if changed_rows == 1 {
        Ok(())
    } else {
        Err(changed())
    }
}

struct WindowRow {
    job_id: String,
    window_ref: String,
    source_refs_json: String,
    model: String,
    reasoning_effort: String,
    state: String,
    output_json: Option<String>,
    plan_json: Option<String>,
    attempt_count: i64,
    recovery_base_attempt_count: i64,
    input_json: Option<String>,
}

fn select_window(
    tx: &Transaction<'_>,
    job_id: Option<&str>,
    now: &str,
) -> CognitionResult<Option<WindowRow>> {
    let sql = format!(
        "SELECT w.job_id,w.window_ref,w.source_refs_json,\
        COALESCE(CASE p.active_slot WHEN 'primary' THEN p.primary_model WHEN 'fallback' THEN p.fallback_model END,j.extraction_model),\
        COALESCE(CASE p.active_slot WHEN 'primary' THEN p.primary_effort WHEN 'fallback' THEN p.fallback_effort END,j.reasoning_effort),\
        w.state,w.output_json,w.normalized_plan_json,w.attempt_count,w.recovery_base_attempt_count,w.input_json \
        FROM memory_projection_windows w JOIN memory_projection_jobs j ON j.job_id=w.job_id \
        LEFT JOIN memory_projection_model_policy p ON p.id=1 \
        WHERE w.state IN ('pending','planned') AND w.owner_nonce IS NULL \
        AND (w.state='planned' OR w.output_json IS NOT NULL OR (SELECT COUNT(DISTINCT a.invocation_ref) \
        FROM memory_projection_attempts a WHERE a.window_ref=w.window_ref AND a.provider_invoked=1 \
        AND a.recovery_revision IS w.recovery_revision)<3) AND (w.next_attempt_at IS NULL OR w.next_attempt_at<=?1) {} \
        ORDER BY j.last_served_at IS NOT NULL,j.last_served_at,j.created_at,j.job_id,w.ordinal LIMIT 1",
        if job_id.is_some() {
            "AND w.job_id=?2"
        } else {
            ""
        }
    );
    tx.query_row(
        &sql,
        rusqlite::params_from_iter([Some(now), job_id].into_iter().take(if job_id.is_some() {
            2
        } else {
            1
        })),
        |r| {
            Ok(WindowRow {
                job_id: r.get(0)?,
                window_ref: r.get(1)?,
                source_refs_json: r.get(2)?,
                model: r.get(3)?,
                reasoning_effort: r.get(4)?,
                state: r.get(5)?,
                output_json: r.get(6)?,
                plan_json: r.get(7)?,
                attempt_count: r.get(8)?,
                recovery_base_attempt_count: r.get(9)?,
                input_json: r.get(10)?,
            })
        },
    )
    .optional()
    .map_err(db_error)
}

pub(super) fn recover_interrupted(
    tx: &Transaction<'_>,
    input: &ClaimProjectionWindowInput<'_>,
) -> CognitionResult<()> {
    let mut statement=tx.prepare("SELECT window_ref,job_id,owner_pid,owner_nonce FROM memory_projection_windows WHERE state IN ('running','planned') AND owner_nonce IS NOT NULL").map_err(db_error)?;
    let rows = statement
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<u64>>(2)?,
                r.get::<_, String>(3)?,
            ))
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    let mut jobs = HashSet::new();
    for (window, job, pid, nonce) in rows {
        let active = input
            .active_owners
            .contains(&(job.clone(), window.clone(), nonce.clone()));
        let abandoned_here = pid == Some(u64::from(input.owner_pid)) && !active;
        let dead_elsewhere = pid.is_some_and(|pid| {
            pid != u64::from(input.owner_pid)
                && (input.process_status)(pid) == CognitionProcessStatus::DefinitelyDead
        });
        if !(abandoned_here || dead_elsewhere) {
            continue;
        }
        let state = tx.query_row(
            "SELECT attempt_count,recovery_revision,input_sha256,normalized_plan_json,output_json,provider_evidence_json FROM memory_projection_windows WHERE window_ref=?1",
            [&window],
            |row| {
                Ok(InterruptedProjectionWindow {
                    attempt_count: row.get(0)?,
                    recovery_revision: row.get(1)?,
                    input_sha256: row.get(2)?,
                    normalized_plan: row.get(3)?,
                    output_json: row.get(4)?,
                    provider_evidence_json: row.get(5)?,
                })
            },
        ).map_err(db_error)?;
        let unknown=state.normalized_plan.is_none()&&state.output_json.is_none()&&tx.query_row("SELECT EXISTS(SELECT 1 FROM memory_projection_attempts started WHERE window_ref=?1 AND invocation_ref=?2 AND outcome_known=0 AND NOT EXISTS(SELECT 1 FROM memory_projection_attempts settled WHERE settled.window_ref=started.window_ref AND settled.invocation_ref=started.invocation_ref AND settled.outcome_known=1))",params![window,nonce],|r|r.get::<_,bool>(0)).map_err(db_error)?;
        let exhausted =
            provider_attempt_count(tx, &window, state.recovery_revision.as_deref())? >= 3;
        let kind = if state.normalized_plan.is_some() {
            "apply"
        } else if state.output_json.is_some() {
            "validation"
        } else {
            "unknown"
        };
        tx.execute("INSERT OR IGNORE INTO memory_projection_attempts(attempt_ref,window_ref,job_id,attempt_count,state,error_code,input_sha256,output_json,provider_evidence_json,recorded_at,attempt_kind,provider_invoked,outcome_known,recovery_revision) VALUES(?1,?2,?3,?4,'interrupted','memory_projection_interrupted',?5,?6,?7,?8,?9,0,0,?10)",params![format!("{window}:attempt:{}:interrupted",state.attempt_count),window,job,state.attempt_count,state.input_sha256,state.output_json,state.provider_evidence_json,input.now,kind,state.recovery_revision]).map_err(db_error)?;
        let (state, code, next) = if state.normalized_plan.is_some() {
            ("planned", "memory_projection_interrupted", Some(input.now))
        } else if state.output_json.is_some() {
            ("pending", "memory_projection_interrupted", Some(input.now))
        } else if unknown {
            ("failed", "memory_projection_outcome_unknown", None)
        } else if exhausted {
            ("failed", "memory_projection_attempts_exhausted", None)
        } else {
            ("pending", "memory_projection_interrupted", Some(input.now))
        };
        tx.execute("UPDATE memory_projection_windows SET state=?1,error_code=?2,next_attempt_at=?3,owner_pid=NULL,owner_nonce=NULL,started_at=NULL WHERE window_ref=?4 AND state IN ('running','planned') AND owner_nonce=?5",params![state,code,next,window,nonce]).map_err(db_error)?;
        jobs.insert(job);
    }
    drop(statement);
    for job in jobs {
        jobs::refresh_semantic_state(tx, &job, input.now)?;
    }
    Ok(())
}

fn provider_attempt_count(
    tx: &Connection,
    window: &str,
    recovery: Option<&str>,
) -> CognitionResult<i64> {
    tx.query_row("SELECT COUNT(DISTINCT invocation_ref) FROM memory_projection_attempts WHERE window_ref=?1 AND provider_invoked=1 AND recovery_revision IS ?2",params![window,recovery],|r|r.get(0)).map_err(db_error)
}
fn parse<T: serde::de::DeserializeOwned>(value: &str) -> CognitionResult<T> {
    serde_json::from_str(value).map_err(json_error)
}
fn parse_optional(value: Option<&str>) -> CognitionResult<Option<Value>> {
    value.map(parse).transpose()
}
fn stringify(value: &Value) -> CognitionResult<String> {
    crate::json::stringify(value).map_err(json_error)
}
fn json_error(error: impl std::fmt::Display) -> CognitionError {
    CognitionError::new("memory_graph_unavailable", error.to_string())
}
fn changed() -> CognitionError {
    CognitionError::new(
        "memory_projection_window_changed",
        "memory_projection_window_changed",
    )
}

#[cfg(test)]
mod tests;
