//! Strict operator request parsing for pinned projection-input repair.

use std::collections::HashSet;

use serde_json::Value;

use super::error;
use crate::cognition::CognitionResult;

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

impl CandidateInputRepairRequest {
    pub(in crate::cognition) fn parse(bytes: &[u8]) -> CognitionResult<Self> {
        if bytes.len() > MAX_REPAIR_REQUEST_BYTES {
            return Err(error("memory_input_repair_invalid_request"));
        }
        let value: Value = serde_json::from_slice(bytes)
            .map_err(|_| error("memory_input_repair_invalid_request"))?;
        let object = value
            .as_object()
            .filter(|object| {
                object.len() == 2 && object.contains_key("schema") && object.contains_key("windows")
            })
            .ok_or_else(|| error("memory_input_repair_invalid_request"))?;
        if object.get("schema").and_then(Value::as_str) != Some(INPUT_REPAIR_SCHEMA) {
            return Err(error("memory_input_repair_invalid_request"));
        }
        let rows = object
            .get("windows")
            .and_then(Value::as_array)
            .filter(|rows| !rows.is_empty() && rows.len() <= MAX_REPAIR_WINDOWS)
            .ok_or_else(|| error("memory_input_repair_invalid_request"))?;
        let mut windows = Vec::with_capacity(rows.len());
        let mut seen = HashSet::with_capacity(rows.len());
        for row in rows {
            let fields = row
                .as_object()
                .filter(|fields| {
                    fields.keys().all(|key| {
                        matches!(
                            key.as_str(),
                            "window_ref"
                                | "expected_input_sha256"
                                | "expected_attempt_count"
                                | "candidate_source_sha256"
                        )
                    }) && [
                        "window_ref",
                        "expected_input_sha256",
                        "expected_attempt_count",
                    ]
                    .iter()
                    .all(|key| fields.contains_key(*key))
                })
                .ok_or_else(|| error("memory_input_repair_invalid_request"))?;
            let window_ref = required_sha(fields.get("window_ref"))?;
            let expected_input_sha256 = required_sha(fields.get("expected_input_sha256"))?;
            let expected_attempt_count = safe_attempt_count(fields.get("expected_attempt_count"))?;
            let candidate_source_sha256 = match fields.get("candidate_source_sha256") {
                None => None,
                Some(value) => Some(required_sha(Some(value))?),
            };
            if !seen.insert(window_ref.clone()) {
                return Err(error("memory_input_repair_invalid_request"));
            }
            windows.push(CandidateInputRepairExpected {
                window_ref,
                expected_input_sha256,
                expected_attempt_count,
                candidate_source_sha256,
            });
        }
        Ok(Self { windows })
    }
}

fn required_sha(value: Option<&Value>) -> CognitionResult<String> {
    let value = value
        .and_then(Value::as_str)
        .ok_or_else(|| error("memory_input_repair_invalid_request"))?;
    if !valid_sha(value) {
        return Err(error("memory_input_repair_invalid_request"));
    }
    Ok(value.to_owned())
}

fn safe_attempt_count(value: Option<&Value>) -> CognitionResult<i64> {
    let Some(number) = value.and_then(Value::as_f64) else {
        return Err(error("memory_input_repair_invalid_request"));
    };
    if !number.is_finite()
        || number.fract() != 0.0
        || !(0.0..=9_007_199_254_740_991.0).contains(&number)
    {
        return Err(error("memory_input_repair_invalid_request"));
    }
    Ok(crate::json::saturating_i64(number))
}

fn valid_sha(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
