//! Durable provider invocation and extraction-stage replay records.
//!
//! A running window keeps every stage result in
//! `memory_projection_windows.extraction_stages_json` (keyed by stage and
//! request hash) and logs each provider intent, stage and result in
//! `memory_projection_attempts`. Writes require the window's owner nonce.

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::db_error;
use super::plan::NormalizedPlan;
use crate::cognition::CognitionCode;
use crate::cognition::extraction::{ExtractInput, ExtractOutput, ProviderEvidence, RunEvidence};
use crate::cognition::{CognitionError, CognitionResult};

/// A provider answer saved before validation, replayed for the same request.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(in crate::cognition) struct ExtractionStageResult {
    pub request_hash: String,
    pub raw: String,
    pub evidence: ProviderEvidence,
}

pub(super) fn pin_binding_candidates(
    connection: &Connection,
    window: &str,
    nonce: &str,
    input: &ExtractInput,
) -> CognitionResult<()> {
    let json = stringify(input)?;
    let sha = crate::cognition::sources::projection_hash_for_graph(&("extract-input", &json))?;
    if connection.execute("UPDATE memory_projection_windows SET input_json=?1,input_sha256=?2 WHERE window_ref=?3 AND state='running' AND owner_nonce=?4",params![json,sha,window,nonce]).map_err(db_error)?!=1 {return Err(changed());}
    Ok(())
}

pub(super) fn read(
    connection: &Connection,
    window: &str,
    key: &str,
) -> CognitionResult<Option<ExtractionStageResult>> {
    let stored = connection
        .query_row(
            "SELECT extraction_stages_json FROM memory_projection_windows WHERE window_ref=?1",
            [window],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(db_error)?;
    let Some(stored) = stored else {
        return Ok(None);
    };
    let stages: Map<String, Value> = serde_json::from_str(&stored).map_err(json_error)?;
    stages
        .get(key)
        .cloned()
        .map(|value| serde_json::from_value(value).map_err(json_error))
        .transpose()
}

pub(super) fn invocation_intent(
    connection: &Connection,
    window: &str,
    nonce: &str,
    now: &str,
) -> CognitionResult<()> {
    let row=connection.query_row("SELECT job_id,attempt_count,recovery_revision,input_sha256 FROM memory_projection_windows WHERE window_ref=?1 AND state='running' AND owner_nonce=?2",params![window,nonce],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,Option<String>>(3)?))).optional().map_err(db_error)?.ok_or_else(changed)?;
    connection.execute("INSERT OR REPLACE INTO memory_projection_attempts(attempt_ref,window_ref,job_id,attempt_count,state,error_code,input_sha256,output_json,provider_evidence_json,recorded_at,attempt_kind,provider_invoked,outcome_known,invocation_ref,recovery_revision) VALUES(?1,?2,?3,?4,'invocation_intent',NULL,?5,NULL,NULL,?6,'provider_intent',0,0,?7,?8)",params![format!("{window}:attempt:{}:intent",row.1),window,row.0,row.1,row.3,now,nonce,row.2]).map_err(db_error)?;
    Ok(())
}

/// Saves a stage result under `key` (a different result for a saved key is
/// a changed stage) and settles the provider intent.
pub(super) fn save(
    connection: &mut Connection,
    window: &str,
    nonce: &str,
    key: &str,
    result: &ExtractionStageResult,
    now: &str,
) -> CognitionResult<()> {
    let tx = connection.transaction().map_err(db_error)?;
    let stored=tx.query_row("SELECT extraction_stages_json FROM memory_projection_windows WHERE window_ref=?1 AND state='running' AND owner_nonce=?2",params![window,nonce],|r|r.get::<_,String>(0)).optional().map_err(db_error)?.ok_or_else(changed)?;
    // Passthrough: the other stages' saved results are rewritten unchanged.
    let mut stages: Map<String, Value> = serde_json::from_str(&stored).map_err(json_error)?;
    let value = serde_json::to_value(result).map_err(json_error)?;
    if stages.get(key).is_some_and(|saved| saved != &value) {
        return Err(CognitionError::new(
            CognitionCode::MemoryExtractStageChanged,
            "memory_extract_stage_changed",
        ));
    }
    stages.insert(key.to_owned(), value);
    tx.execute("UPDATE memory_projection_windows SET extraction_stages_json=?1 WHERE window_ref=?2 AND owner_nonce=?3",params![stringify(&stages)?,window,nonce]).map_err(db_error)?;
    tx.execute("UPDATE memory_projection_attempts SET outcome_known=1,provider_invoked=1 WHERE window_ref=?1 AND invocation_ref=?2 AND state='invocation_intent'",params![window,nonce]).map_err(db_error)?;
    tx.execute("INSERT OR IGNORE INTO memory_projection_attempts(attempt_ref,window_ref,job_id,attempt_count,state,error_code,input_sha256,output_json,provider_evidence_json,recorded_at,attempt_kind,provider_invoked,outcome_known,invocation_ref,recovery_revision) SELECT ?1,window_ref,job_id,attempt_count,'provider_stage',NULL,input_sha256,?2,?3,?4,'provider',1,1,?5,recovery_revision FROM memory_projection_windows WHERE window_ref=?6 AND owner_nonce=?5",params![format!("{window}:stage:{key}"),result.raw,stringify(&result.evidence)?,now,nonce,window]).map_err(db_error)?;
    tx.commit().map_err(db_error)
}

/// Records the run's output and evidence on the window and as a
/// `provider_result` attempt.
pub(super) fn save_result(
    connection: &mut Connection,
    window: &str,
    nonce: &str,
    output: &ExtractOutput,
    evidence: &RunEvidence,
    now: &str,
) -> CognitionResult<()> {
    let tx = connection.transaction().map_err(db_error)?;
    let output = stringify(output)?;
    let evidence = stringify(evidence)?;
    if tx.execute("UPDATE memory_projection_windows SET output_json=?1,provider_evidence_json=?2 WHERE window_ref=?3 AND state='running' AND owner_nonce=?4",params![output,evidence,window,nonce]).map_err(db_error)?!=1{return Err(changed())}
    let row=tx.query_row("SELECT job_id,attempt_count,recovery_revision,input_sha256 FROM memory_projection_windows WHERE window_ref=?1 AND owner_nonce=?2",params![window,nonce],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,Option<String>>(3)?))).map_err(db_error)?;
    tx.execute("INSERT OR REPLACE INTO memory_projection_attempts(attempt_ref,window_ref,job_id,attempt_count,state,error_code,input_sha256,output_json,provider_evidence_json,recorded_at,attempt_kind,provider_invoked,outcome_known,invocation_ref,recovery_revision) VALUES(?1,?2,?3,?4,'provider_result',NULL,?5,?6,?7,?8,'provider',1,1,?9,?10)",params![format!("{window}:attempt:{}:provider",row.1),window,row.0,row.1,row.3,output,evidence,now,nonce,row.2]).map_err(db_error)?;
    tx.commit().map_err(db_error)
}

/// Moves the window to `planned` with its output and normalized plan.
pub(super) fn save_plan(
    connection: &Connection,
    job: &str,
    window: &str,
    nonce: &str,
    output: &ExtractOutput,
    plan: &NormalizedPlan,
) -> CognitionResult<()> {
    let changed_rows=connection.execute("UPDATE memory_projection_windows SET output_json=?1,normalized_plan_json=?2,state='planned',error_code=NULL WHERE window_ref=?3 AND job_id=?4 AND state='running' AND owner_nonce=?5",params![stringify(output)?,stringify(plan)?,window,job,nonce]).map_err(db_error)?;
    if changed_rows == 1 {
        Ok(())
    } else {
        Err(changed())
    }
}

fn stringify<T: Serialize + ?Sized>(value: &T) -> CognitionResult<String> {
    crate::js_json::stringify(value).map_err(json_error)
}
fn json_error(error: impl std::error::Error + Send + Sync + 'static) -> CognitionError {
    CognitionError::new(CognitionCode::MemoryGraphUnavailable, error.to_string()).with_source(error)
}
fn changed() -> CognitionError {
    CognitionError::new(
        CognitionCode::MemoryProjectionWindowChanged,
        "memory_projection_window_changed",
    )
}
