use std::collections::HashSet;

use serde_json::{Map, Value};

use crate::btcc::BtccError;

use super::types::{TurnContinuationBudgetLimits, TurnContinuationBudgetState};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
use super::{TURN_CONTINUATION_BUDGET_SCHEMA, TURN_CONTINUATION_EXHAUSTED_CODE};

pub(crate) fn select_turn_continuation_budget(
    read_env: impl Fn(&str) -> Option<String>,
) -> Result<Option<TurnContinuationBudgetLimits>, BtccError> {
    let enabled = read_env("BUTLER_BOUNDED_STATELESS_CONTEXT")
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if !matches!(enabled.as_str(), "1" | "true" | "on" | "yes") {
        return Ok(None);
    }
    let mut limits = default_limits();
    for (field, key) in ENV_KEYS {
        let Some(raw) = read_env(key) else { continue };
        if raw.trim().is_empty() {
            continue;
        }
        let parsed = raw.trim().parse::<u64>().map_err(|_| {
            BtccError::new(
                "invalid_turn_continuation_limit",
                format!("invalid_turn_continuation_limit:{key}"),
            )
        })?;
        if parsed == 0 || parsed > MAX_SAFE_INTEGER {
            return Err(BtccError::new(
                "invalid_turn_continuation_limit",
                format!("invalid_turn_continuation_limit:{key}"),
            ));
        }
        field.set(&mut limits, parsed);
    }
    validate_turn_continuation_limits(limits).map(Some)
}

pub(crate) fn continuation_limits_for_model(
    limits: TurnContinuationBudgetLimits,
    context_window_tokens: Option<f64>,
) -> TurnContinuationBudgetLimits {
    let Some(tokens) = context_window_tokens.filter(|value| value.is_finite() && *value != 0.0)
    else {
        return limits;
    };
    if limits.max_model_facing_bytes != default_limits().max_model_facing_bytes {
        return limits;
    }
    TurnContinuationBudgetLimits {
        max_model_facing_bytes: model_context_byte_limit(Some(tokens)),
        ..limits
    }
}

pub(crate) fn model_context_byte_limit(context_window_tokens: Option<f64>) -> u64 {
    let defaults = default_limits();
    let ceilings = hard_ceilings();
    let Some(tokens) = context_window_tokens.filter(|value| value.is_finite() && *value != 0.0)
    else {
        return defaults.max_model_facing_bytes;
    };
    let scaled = (tokens.trunc() * 2.0).max(0.0) as u64;
    scaled
        .max(defaults.max_model_facing_bytes)
        .min(ceilings.max_model_facing_bytes)
}

pub(crate) fn validate_turn_continuation_limits(
    limits: TurnContinuationBudgetLimits,
) -> Result<TurnContinuationBudgetLimits, BtccError> {
    let ceilings = hard_ceilings();
    for field in FIELDS {
        let value = field.get(&limits);
        if value == 0 || value > MAX_SAFE_INTEGER || value > field.get(&ceilings) {
            return Err(BtccError::new(
                "unsafe_turn_continuation_limit",
                format!("unsafe_turn_continuation_limit:{}", field.name()),
            ));
        }
    }
    Ok(limits)
}

pub(crate) fn create_turn_continuation_budget_state(
    turn_id: String,
    limits: TurnContinuationBudgetLimits,
    now_ms: u64,
) -> Result<TurnContinuationBudgetState, BtccError> {
    Ok(TurnContinuationBudgetState {
        schema_version: TURN_CONTINUATION_BUDGET_SCHEMA.to_owned(),
        turn_id: required_text(turn_id)?,
        limits: validate_turn_continuation_limits(limits)?,
        admitted_requests: Vec::new(),
        completed_output_rounds: Vec::new(),
        completed_tool_rounds: Vec::new(),
        consumed_output_bytes: 0,
        consumed_model_facing_bytes: 0,
        started_at_ms: integer(now_ms)?,
        last_progress_at_ms: integer(now_ms)?,
        terminal: None,
        extensions: Map::new(),
    })
}

pub(crate) fn parse_turn_continuation_budget_state(
    value: Value,
    turn_id: &str,
) -> Result<TurnContinuationBudgetState, BtccError> {
    let state: TurnContinuationBudgetState = serde_json::from_value(value).map_err(|_| {
        BtccError::new("invalid_continuation_budget", "invalid_continuation_budget")
    })?;
    validate_state(state, turn_id)
}
pub(super) fn validate_state(
    mut state: TurnContinuationBudgetState,
    turn_id: &str,
) -> Result<TurnContinuationBudgetState, BtccError> {
    if state.schema_version != TURN_CONTINUATION_BUDGET_SCHEMA || state.turn_id != turn_id {
        return Err(BtccError::new(
            "invalid_continuation_budget_identity",
            "invalid_continuation_budget_identity",
        ));
    }
    state.limits = validate_turn_continuation_limits(state.limits)?;
    let mut rounds = HashSet::new();
    for admission in &mut state.admitted_requests {
        admission.round_id = required_text(std::mem::take(&mut admission.round_id))?;
        admission.request_digest = required_digest(std::mem::take(&mut admission.request_digest))?;
        admission.model_facing_bytes = integer(admission.model_facing_bytes)?;
        if !rounds.insert(admission.round_id.clone()) {
            return duplicate_round();
        }
    }
    validate_rounds(&mut state.completed_output_rounds)?;
    validate_rounds(&mut state.completed_tool_rounds)?;
    state.consumed_output_bytes = integer(state.consumed_output_bytes)?;
    state.consumed_model_facing_bytes = integer(state.consumed_model_facing_bytes)?;
    if state.terminal.is_none() && state.consumed_output_bytes > state.limits.max_output_bytes {
        return Err(BtccError::new(
            "invalid_continuation_budget_output_bound",
            "invalid_continuation_budget_output_bound",
        ));
    }
    if state.terminal.is_none()
        && state.consumed_model_facing_bytes > state.limits.max_cumulative_model_facing_bytes
    {
        return Err(BtccError::new(
            "invalid_continuation_budget_prompt_bound",
            "invalid_continuation_budget_prompt_bound",
        ));
    }
    state.started_at_ms = integer(state.started_at_ms)?;
    state.last_progress_at_ms = integer(state.last_progress_at_ms)?;
    if state.last_progress_at_ms < state.started_at_ms {
        return Err(BtccError::new(
            "invalid_continuation_budget_time",
            "invalid_continuation_budget_time",
        ));
    }
    if let Some(terminal) = &mut state.terminal {
        if terminal.code != TURN_CONTINUATION_EXHAUSTED_CODE {
            return Err(BtccError::new(
                "invalid_continuation_budget_terminal",
                "invalid_continuation_budget_terminal",
            ));
        }
        terminal.exhausted_at_ms = integer(terminal.exhausted_at_ms)?;
    }
    Ok(state)
}

fn validate_rounds(rounds: &mut [String]) -> Result<(), BtccError> {
    let mut found = HashSet::new();
    for round in rounds {
        *round = required_text(std::mem::take(round))?;
        if !found.insert(round.clone()) {
            return duplicate_round();
        }
    }
    Ok(())
}

pub(super) fn safe_add(left: u64, right: u64) -> u64 {
    left.saturating_add(right).min(MAX_SAFE_INTEGER)
}

pub(super) fn integer(value: u64) -> Result<u64, BtccError> {
    (value <= MAX_SAFE_INTEGER).then_some(value).ok_or_else(|| {
        BtccError::new(
            "invalid_continuation_budget_integer",
            "invalid_continuation_budget_integer",
        )
    })
}

pub(super) fn required_text(value: String) -> Result<String, BtccError> {
    let length = value.encode_utf16().count();
    (length > 0 && length <= 200)
        .then_some(value)
        .ok_or_else(|| {
            BtccError::new(
                "invalid_continuation_budget_text",
                "invalid_continuation_budget_text",
            )
        })
}

pub(super) fn required_digest(value: String) -> Result<String, BtccError> {
    (value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
    .then_some(value)
    .ok_or_else(|| {
        BtccError::new(
            "invalid_continuation_budget_digest",
            "invalid_continuation_budget_digest",
        )
    })
}

fn duplicate_round<T>() -> Result<T, BtccError> {
    Err(BtccError::new(
        "invalid_continuation_budget_duplicate_round",
        "invalid_continuation_budget_duplicate_round",
    ))
}
#[derive(Clone, Copy)]
enum LimitField {
    ModelRequests,
    ToolRounds,
    ModelFacingBytes,
    CumulativeModelFacingBytes,
    OutputBytes,
    ElapsedMs,
    IdleMs,
}

impl LimitField {
    fn get(self, limits: &TurnContinuationBudgetLimits) -> u64 {
        match self {
            Self::ModelRequests => limits.max_model_requests,
            Self::ToolRounds => limits.max_tool_rounds,
            Self::ModelFacingBytes => limits.max_model_facing_bytes,
            Self::CumulativeModelFacingBytes => limits.max_cumulative_model_facing_bytes,
            Self::OutputBytes => limits.max_output_bytes,
            Self::ElapsedMs => limits.max_elapsed_ms,
            Self::IdleMs => limits.max_idle_ms,
        }
    }

    fn set(self, limits: &mut TurnContinuationBudgetLimits, value: u64) {
        match self {
            Self::ModelRequests => limits.max_model_requests = value,
            Self::ToolRounds => limits.max_tool_rounds = value,
            Self::ModelFacingBytes => limits.max_model_facing_bytes = value,
            Self::CumulativeModelFacingBytes => {
                limits.max_cumulative_model_facing_bytes = value;
            }
            Self::OutputBytes => limits.max_output_bytes = value,
            Self::ElapsedMs => limits.max_elapsed_ms = value,
            Self::IdleMs => limits.max_idle_ms = value,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::ModelRequests => "maxModelRequests",
            Self::ToolRounds => "maxToolRounds",
            Self::ModelFacingBytes => "maxModelFacingBytes",
            Self::CumulativeModelFacingBytes => "maxCumulativeModelFacingBytes",
            Self::OutputBytes => "maxOutputBytes",
            Self::ElapsedMs => "maxElapsedMs",
            Self::IdleMs => "maxIdleMs",
        }
    }
}

const FIELDS: [LimitField; 7] = [
    LimitField::ModelRequests,
    LimitField::ToolRounds,
    LimitField::ModelFacingBytes,
    LimitField::CumulativeModelFacingBytes,
    LimitField::OutputBytes,
    LimitField::ElapsedMs,
    LimitField::IdleMs,
];

const ENV_KEYS: [(LimitField, &str); 7] = [
    (
        LimitField::ModelRequests,
        "BUTLER_CONTINUATION_MAX_MODEL_REQUESTS",
    ),
    (
        LimitField::ToolRounds,
        "BUTLER_CONTINUATION_MAX_TOOL_ROUNDS",
    ),
    (
        LimitField::ModelFacingBytes,
        "BUTLER_CONTINUATION_MAX_MODEL_FACING_BYTES",
    ),
    (
        LimitField::CumulativeModelFacingBytes,
        "BUTLER_CONTINUATION_MAX_CUMULATIVE_MODEL_FACING_BYTES",
    ),
    (
        LimitField::OutputBytes,
        "BUTLER_CONTINUATION_MAX_OUTPUT_BYTES",
    ),
    (LimitField::ElapsedMs, "BUTLER_CONTINUATION_MAX_ELAPSED_MS"),
    (LimitField::IdleMs, "BUTLER_CONTINUATION_MAX_IDLE_MS"),
];

fn default_limits() -> TurnContinuationBudgetLimits {
    limits(
        60,
        60,
        192 * 1024,
        8 * 1024 * 1024,
        512 * 1024,
        2 * 60 * 60 * 1_000,
        20 * 60 * 1_000,
    )
}

fn hard_ceilings() -> TurnContinuationBudgetLimits {
    limits(
        200,
        200,
        4 * 1024 * 1024,
        64 * 1024 * 1024,
        4 * 1024 * 1024,
        24 * 60 * 60 * 1_000,
        60 * 60 * 1_000,
    )
}

#[allow(clippy::too_many_arguments)]
fn limits(
    max_model_requests: u64,
    max_tool_rounds: u64,
    max_model_facing_bytes: u64,
    max_cumulative_model_facing_bytes: u64,
    max_output_bytes: u64,
    max_elapsed_ms: u64,
    max_idle_ms: u64,
) -> TurnContinuationBudgetLimits {
    TurnContinuationBudgetLimits {
        max_model_requests,
        max_tool_rounds,
        max_model_facing_bytes,
        max_cumulative_model_facing_bytes,
        max_output_bytes,
        max_elapsed_ms,
        max_idle_ms,
        extensions: Map::new(),
    }
}
