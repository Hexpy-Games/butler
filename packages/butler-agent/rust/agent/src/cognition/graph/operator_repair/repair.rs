//! Transactional repair of candidate inputs from pinned source evidence.

use std::{collections::HashSet, path::Path};

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::Serialize;
use serde_json::{Value, json};

use super::{
    error,
    request::{CandidateInputRepairExpected, CandidateInputRepairRequest},
};
use crate::{
    cognition::{CognitionResult, extraction::ExtractInput},
    conversation::ConversationSourceReader,
};

const INPUT_REPAIR_RECEIPT_SCHEMA: &str = "butler.memory-candidate-input-repair-receipt.v1";
const EXTRACT_INPUT_SCHEMA: &str = "butler.memory-extract-input.v2";
const MAX_EXTRACT_INPUT_BYTES: usize = 24 * 1024;

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub(in crate::cognition) struct CandidateInputRepairResult {
    pub(in crate::cognition) repaired: usize,
    pub(in crate::cognition) receipts: Vec<Value>,
}

#[derive(Debug)]
struct RepairWindowRow {
    job_id: String,
    episode_id: String,
    revision: String,
    state: String,
    input_json: Option<String>,
    input_sha256: Option<String>,
    output_json: Option<String>,
    normalized_plan_json: Option<String>,
    owner_nonce: Option<String>,
    owner_pid: Option<i64>,
    attempt_count: i64,
    recovery_revision: Option<String>,
}

pub(super) fn repair_candidate_inputs(
    connection: &mut Connection,
    current_generation: &str,
    canonical: &ConversationSourceReader,
    source_root: &Path,
    request: &CandidateInputRepairRequest,
    dry_run: bool,
    now: &str,
) -> CognitionResult<CandidateInputRepairResult> {
    let tx = connection.transaction().map_err(super::super::db_error)?;
    let mut result = CandidateInputRepairResult::default();
    for expected in &request.windows {
        let row = read_repair_window(&tx, expected, current_generation)?
            .ok_or_else(|| error("memory_input_repair_precondition_changed"))?;
        validate_repair_window(&tx, expected, &row, dry_run)?;

        let pinned_value = parse_input_value(row.input_json.as_deref().unwrap())?;
        let pinned: ExtractInput = serde_json::from_value(pinned_value.clone())
            .map_err(|_| error("memory_input_repair_precondition_changed"))?;
        if pinned.schema != EXTRACT_INPUT_SCHEMA
            || pinned.window_ref != expected.window_ref
            || pinned.episode_ref != row.episode_id
            || pinned.revision != row.revision
        {
            return Err(error("memory_input_repair_precondition_changed"));
        }
        super::super::candidates::assert_pinned_source_current(
            &tx,
            canonical,
            source_root,
            &pinned,
            now,
        )?;

        let candidate_source = load_candidate_source(&tx, expected, &row, &pinned_value)?;
        let candidate_ids = candidate_source
            .get("candidates")
            .and_then(Value::as_array)
            .ok_or_else(|| error("memory_input_repair_precondition_changed"))?
            .iter()
            .map(|candidate| {
                candidate
                    .get("ref")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned)
                    .ok_or_else(|| error("memory_input_repair_precondition_changed"))
            })
            .collect::<CognitionResult<Vec<_>>>()?;

        let candidate_budget = remaining_candidate_bytes(&pinned_value)?;
        let refreshed = super::super::candidates::load_pinned(
            &tx,
            canonical,
            source_root,
            &pinned,
            &candidate_ids,
            candidate_budget,
        )?;
        let refreshed_value =
            serde_json::to_value(&refreshed).map_err(|_| error("memory_graph_failed"))?;
        let mut repaired = pinned_value.clone();
        repaired
            .as_object_mut()
            .ok_or_else(|| error("memory_input_repair_precondition_changed"))?
            .insert("candidates".into(), refreshed_value.clone());
        let serialized = stringify(&repaired)?;
        if serialized.len() > MAX_EXTRACT_INPUT_BYTES {
            return Err(error("memory_extract_input_exceeds_budget"));
        }

        let refreshed_refs = refreshed
            .iter()
            .map(|candidate| candidate.ref_id.as_str())
            .collect::<HashSet<_>>();
        if candidate_ids
            .iter()
            .any(|reference| !refreshed_refs.contains(reference.as_str()))
        {
            return Err(error("memory_input_repair_candidates_incomplete"));
        }

        let prior_sha = row.input_sha256.as_deref().unwrap();
        let digest = extract_input_sha256(&serialized)?;
        if dry_run {
            result.receipts.push(json!({
                "window_ref": expected.window_ref,
                "state": "preview",
                "prior_input_sha256": prior_sha,
                "repaired_input_sha256": digest,
                "repaired_candidates": refreshed_value,
            }));
            continue;
        }
        let pinned_candidates = pinned_value
            .get("candidates")
            .ok_or_else(|| error("memory_input_repair_precondition_changed"))?;
        if stringify(pinned_candidates)? == stringify(&refreshed_value)? {
            result.receipts.push(json!({
                "window_ref": expected.window_ref,
                "state": "unchanged",
                "input_sha256": prior_sha,
            }));
            continue;
        }

        let receipt_ref = repair_receipt_ref(&expected.window_ref, prior_sha, &digest)?;
        let receipt = stringify(&json!({
            "schema": INPUT_REPAIR_RECEIPT_SCHEMA,
            "prior_input_json": row.input_json.as_deref().unwrap(),
            "prior_input_sha256": prior_sha,
            "repaired_input_sha256": digest,
            "candidate_source_sha256": expected.candidate_source_sha256.as_deref().unwrap_or(prior_sha),
            "repaired_at": now,
        }))?;
        tx.execute(
            "INSERT INTO memory_projection_attempts \
             (attempt_ref,window_ref,job_id,attempt_count,state,error_code,input_sha256,recorded_at, \
              attempt_kind,provider_invoked,outcome_known,recovery_revision,recovery_request_json) \
             VALUES(?1,?2,?3,?4,?5,NULL,?6,?7,'recovery',0,1,?8,?9)",
            params![
                receipt_ref,
                expected.window_ref,
                row.job_id,
                row.attempt_count,
                format!("input_repaired:{receipt_ref}"),
                prior_sha,
                now,
                row.recovery_revision,
                receipt,
            ],
        )
        .map_err(super::super::db_error)?;
        let changed = tx
            .execute(
                "UPDATE memory_projection_windows SET input_json=?1,input_sha256=?2 \
                 WHERE window_ref=?3 AND input_sha256=?4 AND attempt_count=?5 \
                   AND state='pending' AND owner_nonce IS NULL AND owner_pid IS NULL",
                params![
                    serialized,
                    digest,
                    expected.window_ref,
                    prior_sha,
                    row.attempt_count,
                ],
            )
            .map_err(super::super::db_error)?;
        if changed != 1 {
            return Err(error("memory_input_repair_precondition_changed"));
        }
        result.repaired += 1;
        result.receipts.push(json!({
            "window_ref": expected.window_ref,
            "state": "repaired",
            "input_sha256": digest,
            "receipt_ref": receipt_ref,
        }));
    }
    tx.commit().map_err(super::super::db_error)?;
    Ok(result)
}

fn read_repair_window(
    tx: &Transaction<'_>,
    expected: &CandidateInputRepairExpected,
    generation: &str,
) -> CognitionResult<Option<RepairWindowRow>> {
    tx.query_row(
        "SELECT w.job_id,j.episode_id,j.revision,w.state,w.input_json,w.input_sha256, \
         w.output_json,w.normalized_plan_json,w.owner_nonce,w.owner_pid,w.attempt_count, \
         w.recovery_revision FROM memory_projection_windows w \
         JOIN memory_projection_jobs j ON j.job_id=w.job_id \
         WHERE w.window_ref=?1 AND j.generation=?2",
        params![expected.window_ref, generation],
        |row| {
            Ok(RepairWindowRow {
                job_id: row.get(0)?,
                episode_id: row.get(1)?,
                revision: row.get(2)?,
                state: row.get(3)?,
                input_json: row.get(4)?,
                input_sha256: row.get(5)?,
                output_json: row.get(6)?,
                normalized_plan_json: row.get(7)?,
                owner_nonce: row.get(8)?,
                owner_pid: row.get(9)?,
                attempt_count: row.get(10)?,
                recovery_revision: row.get(11)?,
            })
        },
    )
    .optional()
    .map_err(super::super::db_error)
}

fn validate_repair_window(
    tx: &Transaction<'_>,
    expected: &CandidateInputRepairExpected,
    row: &RepairWindowRow,
    dry_run: bool,
) -> CognitionResult<()> {
    let state_allowed = row.state == "pending" || (dry_run && row.state == "complete");
    let prior_input = row
        .input_json
        .as_deref()
        .ok_or_else(|| error("memory_input_repair_precondition_changed"))?;
    if !state_allowed
        || row.owner_nonce.is_some()
        || row.owner_pid.is_some()
        || (!dry_run && (row.output_json.is_some() || row.normalized_plan_json.is_some()))
        || row.input_sha256.as_deref() != Some(expected.expected_input_sha256.as_str())
        || row.attempt_count != expected.expected_attempt_count
        || extract_input_sha256(prior_input)? != expected.expected_input_sha256
    {
        return Err(error("memory_input_repair_precondition_changed"));
    }
    if !dry_run {
        let unknown: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM memory_projection_attempts a \
                 WHERE a.window_ref=?1 AND a.provider_invoked=1 AND a.outcome_known=0 \
                   AND NOT EXISTS(SELECT 1 FROM memory_projection_attempts settled \
                     WHERE settled.window_ref=a.window_ref \
                       AND settled.invocation_ref=a.invocation_ref AND settled.outcome_known=1))",
                [&expected.window_ref],
                |row| row.get(0),
            )
            .map_err(super::super::db_error)?;
        if unknown {
            return Err(error("memory_input_repair_precondition_changed"));
        }
    }
    Ok(())
}

fn load_candidate_source(
    tx: &Transaction<'_>,
    expected: &CandidateInputRepairExpected,
    row: &RepairWindowRow,
    pinned: &Value,
) -> CognitionResult<Value> {
    let Some(candidate_sha) = expected
        .candidate_source_sha256
        .as_deref()
        .filter(|candidate_sha| Some(*candidate_sha) != row.input_sha256.as_deref())
    else {
        return Ok(pinned.clone());
    };
    let archived: Option<String> = tx
        .query_row(
            "SELECT recovery_request_json FROM memory_projection_attempts \
             WHERE window_ref=?1 AND attempt_kind='recovery' \
               AND json_extract(recovery_request_json,'$.schema')=?2 \
               AND json_extract(recovery_request_json,'$.prior_input_sha256')=?3 LIMIT 1",
            params![
                expected.window_ref,
                INPUT_REPAIR_RECEIPT_SCHEMA,
                candidate_sha
            ],
            |row| row.get(0),
        )
        .optional()
        .map_err(super::super::db_error)?;
    let archived = archived.ok_or_else(|| error("memory_input_repair_precondition_changed"))?;
    let receipt: Value = serde_json::from_str(&archived)
        .map_err(|_| error("memory_input_repair_precondition_changed"))?;
    let prior_json = receipt
        .get("prior_input_json")
        .and_then(Value::as_str)
        .ok_or_else(|| error("memory_input_repair_precondition_changed"))?;
    let prior_sha = receipt
        .get("prior_input_sha256")
        .and_then(Value::as_str)
        .ok_or_else(|| error("memory_input_repair_precondition_changed"))?;
    if prior_sha != candidate_sha || extract_input_sha256(prior_json)? != candidate_sha {
        return Err(error("memory_input_repair_precondition_changed"));
    }
    let candidate_source: Value = serde_json::from_str(prior_json)
        .map_err(|_| error("memory_input_repair_precondition_changed"))?;
    for field in [
        "schema",
        "episode_ref",
        "revision",
        "window_ref",
        "bound_project_id",
        "source_units",
        "context_units",
    ] {
        let prior = candidate_source
            .get(field)
            .ok_or_else(|| error("memory_input_repair_precondition_changed"))?;
        let current = pinned
            .get(field)
            .ok_or_else(|| error("memory_input_repair_precondition_changed"))?;
        if stringify(prior)? != stringify(current)? {
            return Err(error("memory_input_repair_precondition_changed"));
        }
    }
    Ok(candidate_source)
}

fn remaining_candidate_bytes(pinned: &Value) -> CognitionResult<usize> {
    let mut empty_candidate_input = pinned.clone();
    empty_candidate_input
        .as_object_mut()
        .ok_or_else(|| error("memory_input_repair_precondition_changed"))?
        .insert("candidates".into(), Value::Array(Vec::new()));
    let base = stringify(&empty_candidate_input)?.len();
    MAX_EXTRACT_INPUT_BYTES
        .checked_sub(base)
        .and_then(|remaining| remaining.checked_add(2))
        .filter(|remaining| *remaining >= 2)
        .ok_or_else(|| error("memory_extract_input_exceeds_budget"))
}

fn extract_input_sha256(serialized: &str) -> CognitionResult<String> {
    Ok(crate::cognition::sources::projection_hash_for_graph(vec![
        Value::String("extract-input".into()),
        Value::String(serialized.into()),
    ])?)
}

fn repair_receipt_ref(
    window_ref: &str,
    prior_sha256: &str,
    repaired_sha256: &str,
) -> CognitionResult<String> {
    Ok(crate::cognition::sources::projection_hash_for_graph(vec![
        Value::String("candidate-input-repair".into()),
        Value::String(window_ref.into()),
        Value::String(prior_sha256.into()),
        Value::String(repaired_sha256.into()),
    ])?)
}

fn parse_input_value(serialized: &str) -> CognitionResult<Value> {
    serde_json::from_str(serialized).map_err(|_| error("memory_input_repair_precondition_changed"))
}

fn stringify(value: &Value) -> CognitionResult<String> {
    crate::json::stringify(value).map_err(|_| error("memory_graph_failed"))
}
