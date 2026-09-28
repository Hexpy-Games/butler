//! Reading and validating the claimed window a candidate-input repair rewrites, and the candidate sources it reloads.

use super::*;

pub(super) fn read_repair_window(
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
    .map_err(super::super::super::db_error)
}

/// A preview may read a completed window; an apply needs a pending window
/// with no output and no invocation whose outcome is unknown.
pub(super) fn validate_repair_window(
    tx: &Transaction<'_>,
    expected: &CandidateInputRepairExpected,
    row: &RepairWindowRow,
    mode: RepairMode,
) -> CognitionResult<()> {
    let apply = mode == RepairMode::Apply;
    let state_allowed = row.state == "pending" || (!apply && row.state == "complete");
    let prior_input = row.input_json.as_deref().ok_or_else(precondition_changed)?;
    if !state_allowed
        || row.owner_nonce.is_some()
        || row.owner_pid.is_some()
        || (apply && (row.output_json.is_some() || row.normalized_plan_json.is_some()))
        || row.input_sha256.as_deref() != Some(expected.expected_input_sha256.as_str())
        || row.attempt_count != expected.expected_attempt_count
        || extract_input_sha256(prior_input)? != expected.expected_input_sha256
    {
        return Err(precondition_changed());
    }
    if apply && has_unknown_outcome(tx, &expected.window_ref)? {
        return Err(precondition_changed());
    }
    Ok(())
}

pub(super) fn has_unknown_outcome(tx: &Transaction<'_>, window_ref: &str) -> CognitionResult<bool> {
    tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM memory_projection_attempts a \
         WHERE a.window_ref=?1 AND a.provider_invoked=1 AND a.outcome_known=0 \
           AND NOT EXISTS(SELECT 1 FROM memory_projection_attempts settled \
             WHERE settled.window_ref=a.window_ref \
               AND settled.invocation_ref=a.invocation_ref AND settled.outcome_known=1))",
        [window_ref],
        |row| row.get(0),
    )
    .map_err(super::super::super::db_error)
}

/// The input whose candidate refs are reloaded: the pinned input, or the
/// archived prior input named by `candidate_source_sha256`, which must agree
/// with the pinned input on everything but its candidates.
pub(super) fn load_candidate_source(
    tx: &Transaction<'_>,
    expected: &CandidateInputRepairExpected,
    row: &RepairWindowRow,
    pinned: &StoredInput,
) -> CognitionResult<StoredInput> {
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
        .map_err(super::super::super::db_error)?;
    let receipt: ArchivedPrior = serde_json::from_str(&archived.ok_or_else(precondition_changed)?)
        .map_err(|source| precondition_changed().with_source(source))?;
    if receipt.prior_input_sha256 != candidate_sha
        || extract_input_sha256(&receipt.prior_input_json)? != candidate_sha
    {
        return Err(precondition_changed());
    }
    let candidate_source = StoredInput::parse(&receipt.prior_input_json)?;
    for field in [
        "schema",
        "episode_ref",
        "revision",
        "window_ref",
        "bound_project_id",
        "source_units",
        "context_units",
    ] {
        if stringify(candidate_source.field(field)?)? != stringify(pinned.field(field)?)? {
            return Err(precondition_changed());
        }
    }
    Ok(candidate_source)
}
