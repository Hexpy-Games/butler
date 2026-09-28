//! Transactional repair of candidate inputs from pinned source evidence.
//!
//! Each requested window's pinned extract input keeps every field but
//! `candidates`, which is reloaded from the current graph. A preview only
//! reports the repaired digest; an apply records a recovery attempt with the
//! prior input and swaps the window's input.

use std::{collections::HashSet, path::Path};

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::{
    error,
    request::{CandidateInputRepairExpected, CandidateInputRepairRequest},
};
use crate::cognition::extraction::{ExtractCandidate, ExtractInput};
use crate::cognition::{CognitionCode, CognitionResult};
use butler_turn::conversation::ConversationSourceReader;
mod window;
use window::{load_candidate_source, read_repair_window, validate_repair_window};

const INPUT_REPAIR_RECEIPT_SCHEMA: &str = "butler.memory-candidate-input-repair-receipt.v1";
const EXTRACT_INPUT_SCHEMA: &str = "butler.memory-extract-input.v2";
const MAX_EXTRACT_INPUT_BYTES: usize = 24 * 1024;

/// Whether a candidate-input repair only reports or also writes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RepairMode {
    /// Report the repaired digests without writing.
    Preview,
    /// Record receipts and replace the window inputs.
    Apply,
}

/// Result of a candidate-input repair.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct CandidateInputRepairResult {
    /// Windows whose input was replaced.
    pub repaired: usize,
    /// One receipt per requested window.
    pub receipts: Vec<RepairReceipt>,
}

/// What happened to one requested window.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RepairReceipt {
    window_ref: String,
    state: RepairState,
    #[serde(flatten)]
    detail: RepairDetail,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum RepairState {
    Preview,
    Unchanged,
    Repaired,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(untagged)]
enum RepairDetail {
    Preview {
        prior_input_sha256: String,
        repaired_input_sha256: String,
        repaired_candidates: Vec<ExtractCandidate>,
    },
    Unchanged {
        input_sha256: String,
    },
    Repaired {
        input_sha256: String,
        receipt_ref: String,
    },
}

/// The recovery receipt archived with each applied repair.
#[derive(Serialize, Deserialize)]
struct InputRepairReceipt {
    schema: String,
    prior_input_json: String,
    prior_input_sha256: String,
    repaired_input_sha256: String,
    candidate_source_sha256: String,
    repaired_at: String,
}

/// Passthrough: a stored extract input kept verbatim so a repair changes only
/// its `candidates` and every other byte of the hashed input survives.
#[derive(Clone)]
struct StoredInput(Map<String, Value>);

impl StoredInput {
    fn parse(serialized: &str) -> CognitionResult<Self> {
        serde_json::from_str(serialized)
            .map(Self)
            .map_err(|source| precondition_changed().with_source(source))
    }

    fn typed(&self) -> CognitionResult<ExtractInput> {
        serde_json::from_value(Value::Object(self.0.clone()))
            .map_err(|source| precondition_changed().with_source(source))
    }

    fn field(&self, name: &str) -> CognitionResult<&Value> {
        self.0.get(name).ok_or_else(precondition_changed)
    }

    /// The `ref` of every candidate, each required and non-empty.
    fn candidate_refs(&self) -> CognitionResult<Vec<String>> {
        #[derive(Deserialize)]
        struct CandidateRef {
            #[serde(rename = "ref")]
            ref_id: String,
        }
        let candidates: Vec<CandidateRef> = Vec::deserialize(self.field("candidates")?)
            .map_err(|source| precondition_changed().with_source(source))?;
        candidates
            .into_iter()
            .map(|candidate| {
                Some(candidate.ref_id)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(precondition_changed)
            })
            .collect()
    }

    fn with_candidates(&self, candidates: &[ExtractCandidate]) -> CognitionResult<Self> {
        let mut repaired = self.0.clone();
        let candidates = serde_json::to_value(candidates)
            .map_err(|source| error(CognitionCode::MemoryGraphFailed).with_source(source))?;
        repaired.insert("candidates".into(), candidates);
        Ok(Self(repaired))
    }

    fn stringify(&self) -> CognitionResult<String> {
        stringify(&self.0)
    }
}

/// A requested window after its pinned input and candidates were reloaded.
struct RefreshedWindow<'a> {
    expected: &'a CandidateInputRepairExpected,
    row: RepairWindowRow,
    prior_input_json: String,
    prior_sha: String,
    pinned: StoredInput,
    refreshed: Vec<ExtractCandidate>,
    /// `JSON.stringify` of `refreshed`, compared with the pinned candidates.
    refreshed_json: String,
    serialized: String,
    digest: String,
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

/// The inputs every window repair shares.
pub(super) struct RepairScope<'a> {
    pub(super) current_generation: &'a str,
    pub(super) canonical: &'a ConversationSourceReader,
    pub(super) source_root: &'a Path,
    pub(super) mode: RepairMode,
    pub(super) now: &'a str,
}

pub(super) fn repair_candidate_inputs(
    connection: &mut Connection,
    scope: &RepairScope<'_>,
    request: &CandidateInputRepairRequest,
) -> CognitionResult<CandidateInputRepairResult> {
    let tx = connection.transaction().map_err(super::super::db_error)?;
    let mut result = CandidateInputRepairResult::default();
    for expected in &request.windows {
        let window = refresh_window(&tx, scope, expected)?;
        let receipt = match scope.mode {
            RepairMode::Preview => window.preview(),
            RepairMode::Apply => window.apply(&tx, scope.now)?,
        };
        if receipt.state == RepairState::Repaired {
            result.repaired += 1;
        }
        result.receipts.push(receipt);
    }
    tx.commit().map_err(super::super::db_error)?;
    Ok(result)
}

/// Validates the window against the request, then reloads its candidates
/// from the current graph within the pinned input's byte budget.
fn refresh_window<'a>(
    tx: &Transaction<'_>,
    scope: &RepairScope<'_>,
    expected: &'a CandidateInputRepairExpected,
) -> CognitionResult<RefreshedWindow<'a>> {
    let row = read_repair_window(tx, expected, scope.current_generation)?
        .ok_or_else(precondition_changed)?;
    validate_repair_window(tx, expected, &row, scope.mode)?;
    // validate_repair_window admitted only rows with a prior input and digest.
    let (Some(prior_input_json), Some(prior_sha)) =
        (row.input_json.clone(), row.input_sha256.clone())
    else {
        return Err(precondition_changed());
    };
    let pinned = StoredInput::parse(&prior_input_json)?;
    let typed = pinned.typed()?;
    if typed.schema != EXTRACT_INPUT_SCHEMA
        || typed.window_ref != expected.window_ref
        || typed.episode_ref != row.episode_id
        || typed.revision != row.revision
    {
        return Err(precondition_changed());
    }
    super::super::candidates::assert_pinned_source_current(
        tx,
        scope.canonical,
        scope.source_root,
        &typed,
        scope.now,
    )?;
    let candidate_ids = load_candidate_source(tx, expected, &row, &pinned)?.candidate_refs()?;
    let refreshed = super::super::candidates::load_pinned(
        tx,
        scope.canonical,
        scope.source_root,
        &typed,
        &candidate_ids,
        remaining_candidate_bytes(&pinned)?,
    )?;
    let refreshed_json = stringify(&refreshed)?;
    let serialized = pinned.with_candidates(&refreshed)?.stringify()?;
    if serialized.len() > MAX_EXTRACT_INPUT_BYTES {
        return Err(error(CognitionCode::MemoryExtractInputExceedsBudget));
    }
    let refreshed_refs = refreshed
        .iter()
        .map(|candidate| candidate.ref_id.as_str())
        .collect::<HashSet<_>>();
    if candidate_ids
        .iter()
        .any(|reference| !refreshed_refs.contains(reference.as_str()))
    {
        return Err(error(CognitionCode::MemoryInputRepairCandidatesIncomplete));
    }
    Ok(RefreshedWindow {
        digest: extract_input_sha256(&serialized)?,
        expected,
        row,
        prior_input_json,
        prior_sha,
        pinned,
        refreshed,
        refreshed_json,
        serialized,
    })
}

impl RefreshedWindow<'_> {
    fn preview(self) -> RepairReceipt {
        RepairReceipt {
            window_ref: self.expected.window_ref.clone(),
            state: RepairState::Preview,
            detail: RepairDetail::Preview {
                prior_input_sha256: self.prior_sha,
                repaired_input_sha256: self.digest,
                repaired_candidates: self.refreshed,
            },
        }
    }

    /// Records the recovery receipt and swaps the window input, unless the
    /// reloaded candidates are identical to the pinned ones.
    fn apply(self, tx: &Transaction<'_>, now: &str) -> CognitionResult<RepairReceipt> {
        let window_ref = self.expected.window_ref.clone();
        if stringify(self.pinned.field("candidates")?)? == self.refreshed_json {
            return Ok(RepairReceipt {
                window_ref,
                state: RepairState::Unchanged,
                detail: RepairDetail::Unchanged {
                    input_sha256: self.prior_sha,
                },
            });
        }
        let receipt_ref = repair_receipt_ref(&window_ref, &self.prior_sha, &self.digest)?;
        self.record_attempt(tx, &receipt_ref, now)?;
        let changed = tx
            .execute(
                "UPDATE memory_projection_windows SET input_json=?1,input_sha256=?2 \
                 WHERE window_ref=?3 AND input_sha256=?4 AND attempt_count=?5 \
                   AND state='pending' AND owner_nonce IS NULL AND owner_pid IS NULL",
                params![
                    self.serialized,
                    self.digest,
                    window_ref,
                    self.prior_sha,
                    self.row.attempt_count,
                ],
            )
            .map_err(super::super::db_error)?;
        if changed != 1 {
            return Err(precondition_changed());
        }
        Ok(RepairReceipt {
            window_ref,
            state: RepairState::Repaired,
            detail: RepairDetail::Repaired {
                input_sha256: self.digest,
                receipt_ref,
            },
        })
    }

    fn record_attempt(
        &self,
        tx: &Transaction<'_>,
        receipt_ref: &str,
        now: &str,
    ) -> CognitionResult<()> {
        let receipt = InputRepairReceipt {
            schema: INPUT_REPAIR_RECEIPT_SCHEMA.into(),
            prior_input_json: self.prior_input_json.clone(),
            prior_input_sha256: self.prior_sha.clone(),
            repaired_input_sha256: self.digest.clone(),
            candidate_source_sha256: self
                .expected
                .candidate_source_sha256
                .clone()
                .unwrap_or_else(|| self.prior_sha.clone()),
            repaired_at: now.to_owned(),
        };
        let receipt = stringify(&receipt)?;
        tx.execute(
            "INSERT INTO memory_projection_attempts \
             (attempt_ref,window_ref,job_id,attempt_count,state,error_code,input_sha256,recorded_at, \
              attempt_kind,provider_invoked,outcome_known,recovery_revision,recovery_request_json) \
             VALUES(?1,?2,?3,?4,?5,NULL,?6,?7,'recovery',0,1,?8,?9)",
            params![
                receipt_ref,
                self.expected.window_ref,
                self.row.job_id,
                self.row.attempt_count,
                format!("input_repaired:{receipt_ref}"),
                self.prior_sha,
                now,
                self.row.recovery_revision,
                receipt,
            ],
        )
        .map_err(super::super::db_error)?;
        Ok(())
    }
}

/// The fields of an archived receipt a candidate source needs.
#[derive(Deserialize)]
struct ArchivedPrior {
    prior_input_json: String,
    prior_input_sha256: String,
}

fn remaining_candidate_bytes(pinned: &StoredInput) -> CognitionResult<usize> {
    let base = pinned.with_candidates(&[])?.stringify()?.len();
    MAX_EXTRACT_INPUT_BYTES
        .checked_sub(base)
        .and_then(|remaining| remaining.checked_add(2))
        .filter(|remaining| *remaining >= 2)
        .ok_or_else(|| error(CognitionCode::MemoryExtractInputExceedsBudget))
}

fn extract_input_sha256(serialized: &str) -> CognitionResult<String> {
    crate::cognition::sources::projection_hash_for_graph(&("extract-input", serialized))
}

fn repair_receipt_ref(
    window_ref: &str,
    prior_sha256: &str,
    repaired_sha256: &str,
) -> CognitionResult<String> {
    crate::cognition::sources::projection_hash_for_graph(&(
        "candidate-input-repair",
        window_ref,
        prior_sha256,
        repaired_sha256,
    ))
}

fn stringify(value: &(impl Serialize + ?Sized)) -> CognitionResult<String> {
    crate::js_json::stringify(value)
        .map_err(|source| error(CognitionCode::MemoryGraphFailed).with_source(source))
}

fn precondition_changed() -> crate::cognition::CognitionError {
    error(CognitionCode::MemoryInputRepairPreconditionChanged)
}
