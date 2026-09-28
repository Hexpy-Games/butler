//! Strict operator request parsing for pinned projection-input repair.

use std::collections::HashSet;

use serde::Deserialize;

use super::error;
use crate::cognition::{CognitionCode, CognitionResult};

const INPUT_REPAIR_SCHEMA: &str = "butler.memory-candidate-input-repair.v1";
const MAX_REPAIR_REQUEST_BYTES: usize = 32 * 1024;
const MAX_REPAIR_WINDOWS: usize = 32;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::cognition) struct CandidateInputRepairExpected {
    pub(in crate::cognition) window_ref: String,
    pub(in crate::cognition) expected_input_sha256: String,
    pub(in crate::cognition) expected_attempt_count: i64,
    pub(in crate::cognition) candidate_source_sha256: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::cognition) struct CandidateInputRepairRequest {
    pub(in crate::cognition) windows: Vec<CandidateInputRepairExpected>,
}

/// The request file as written by the operator; every field is required
/// except `candidate_source_sha256`, and no other field is allowed.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireRequest {
    schema: String,
    windows: Vec<WireWindow>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireWindow {
    window_ref: String,
    expected_input_sha256: String,
    expected_attempt_count: f64,
    #[serde(default, deserialize_with = "crate::lenient::present")]
    candidate_source_sha256: Option<String>,
}

impl CandidateInputRepairRequest {
    pub(in crate::cognition) fn parse(bytes: &[u8]) -> CognitionResult<Self> {
        if bytes.len() > MAX_REPAIR_REQUEST_BYTES {
            return Err(invalid());
        }
        let wire: WireRequest =
            serde_json::from_slice(bytes).map_err(|source| invalid().with_source(source))?;
        if wire.schema != INPUT_REPAIR_SCHEMA
            || wire.windows.is_empty()
            || wire.windows.len() > MAX_REPAIR_WINDOWS
        {
            return Err(invalid());
        }
        let mut windows = Vec::with_capacity(wire.windows.len());
        let mut seen = HashSet::with_capacity(wire.windows.len());
        for row in wire.windows {
            let window = CandidateInputRepairExpected {
                window_ref: sha(row.window_ref)?,
                expected_input_sha256: sha(row.expected_input_sha256)?,
                expected_attempt_count: attempt_count(row.expected_attempt_count)?,
                candidate_source_sha256: row.candidate_source_sha256.map(sha).transpose()?,
            };
            if !seen.insert(window.window_ref.clone()) {
                return Err(invalid());
            }
            windows.push(window);
        }
        Ok(Self { windows })
    }
}

fn sha(value: String) -> CognitionResult<String> {
    if valid_sha(&value) {
        Ok(value)
    } else {
        Err(invalid())
    }
}

fn attempt_count(number: f64) -> CognitionResult<i64> {
    if !number.is_finite()
        || number.fract() != 0.0
        || !(0.0..=9_007_199_254_740_991.0).contains(&number)
    {
        return Err(invalid());
    }
    Ok(butler_core::json::saturating_i64(number))
}

fn valid_sha(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn invalid() -> crate::cognition::CognitionError {
    error(CognitionCode::MemoryInputRepairInvalidRequest)
}
