#[cfg(test)]
mod tests;
mod types;
mod validation;

use crate::btcc::BtccCode;
use serde_json::Map;

use crate::btcc::BtccError;

pub use types::TurnContinuationBudgetLimits;
pub(crate) use types::{
    TurnContinuationAdmission, TurnContinuationBudgetError, TurnContinuationBudgetEvent,
    TurnContinuationBudgetState, TurnContinuationBudgetTerminal,
    TurnContinuationBudgetTerminalReason,
};
pub use validation::select_turn_continuation_budget;
pub(crate) use validation::{
    continuation_limits_for_model, create_turn_continuation_budget_state, model_context_byte_limit,
    parse_turn_continuation_budget_state,
};
use validation::{integer, required_digest, required_text, safe_add, validate_state};

pub(crate) const TURN_CONTINUATION_BUDGET_SCHEMA: &str = "butler.turn-continuation-budget.v2";
pub(crate) const TURN_CONTINUATION_EXHAUSTED_CODE: &str = "turn_continuation_budget_exhausted";

impl TurnContinuationBudgetError {
    pub(crate) fn into_btcc_error(self) -> BtccError {
        match self {
            Self::Invalid(error) => error,
            Self::Exhausted(state) => BtccError::detected(
                BtccCode::TurnContinuationBudgetExhausted,
                format!(
                    "Turn continuation budget exhausted: {}",
                    state
                        .terminal
                        .as_ref()
                        .map(|terminal| reason_name(terminal.reason))
                        .unwrap_or("unknown")
                ),
            ),
        }
    }

    pub(crate) fn exhausted_state(&self) -> Option<&TurnContinuationBudgetState> {
        match self {
            Self::Exhausted(state) => Some(state.as_ref()),
            Self::Invalid(_) => None,
        }
    }
}
pub(crate) fn transition_turn_continuation_budget(
    current: TurnContinuationBudgetState,
    event: TurnContinuationBudgetEvent,
    now_ms: u64,
) -> Result<TurnContinuationBudgetState, TurnContinuationBudgetError> {
    let turn_id = current.turn_id.clone();
    let mut state =
        validate_state(current, &turn_id).map_err(TurnContinuationBudgetError::Invalid)?;
    let now = integer(now_ms).map_err(TurnContinuationBudgetError::Invalid)?;
    if state.terminal.is_some() {
        return Err(TurnContinuationBudgetError::Exhausted(Box::new(state)));
    }
    if now.saturating_sub(state.started_at_ms) >= state.limits.max_elapsed_ms {
        return exhaust(
            state,
            TurnContinuationBudgetTerminalReason::MaxElapsedMs,
            now,
        );
    }
    if now.saturating_sub(state.last_progress_at_ms) >= state.limits.max_idle_ms {
        return exhaust(state, TurnContinuationBudgetTerminalReason::MaxIdleMs, now);
    }
    match event {
        TurnContinuationBudgetEvent::AdmitRequest {
            round_id,
            request_digest,
            model_facing_bytes,
        } => admit_request(state, round_id, request_digest, model_facing_bytes, now),
        TurnContinuationBudgetEvent::RecordToolRound { round_id } => {
            if state.completed_tool_rounds.contains(&round_id) {
                return Ok(state);
            }
            state
                .completed_tool_rounds
                .push(required_text(round_id).map_err(TurnContinuationBudgetError::Invalid)?);
            state.last_progress_at_ms = now;
            Ok(state)
        }
        TurnContinuationBudgetEvent::RecordOutput {
            round_id,
            output_bytes,
        } => {
            if state.completed_output_rounds.contains(&round_id) {
                return Ok(state);
            }
            let output_bytes =
                integer(output_bytes).map_err(TurnContinuationBudgetError::Invalid)?;
            state.consumed_output_bytes = safe_add(state.consumed_output_bytes, output_bytes);
            if state.consumed_output_bytes > state.limits.max_output_bytes {
                return exhaust(
                    state,
                    TurnContinuationBudgetTerminalReason::MaxOutputBytes,
                    now,
                );
            }
            state
                .completed_output_rounds
                .push(required_text(round_id).map_err(TurnContinuationBudgetError::Invalid)?);
            state.last_progress_at_ms = now;
            Ok(state)
        }
    }
}

fn admit_request(
    mut state: TurnContinuationBudgetState,
    round_id: String,
    request_digest: String,
    model_facing_bytes: u64,
    now: u64,
) -> Result<TurnContinuationBudgetState, TurnContinuationBudgetError> {
    let admitted = state
        .admitted_requests
        .iter()
        .find(|item| item.round_id == round_id)
        .map(|item| {
            (
                item.request_digest == request_digest,
                item.model_facing_bytes,
            )
        });
    if let Some((same_request, admitted_bytes)) = admitted {
        return readmit(
            state,
            &round_id,
            Readmission {
                same_request,
                admitted_bytes,
                model_facing_bytes,
            },
            now,
        );
    }
    if model_facing_bytes > state.limits.max_model_facing_bytes {
        return exhaust(
            state,
            TurnContinuationBudgetTerminalReason::ModelFacingBytes,
            now,
        );
    }
    let model_facing_bytes =
        integer(model_facing_bytes).map_err(TurnContinuationBudgetError::Invalid)?;
    state.consumed_model_facing_bytes =
        safe_add(state.consumed_model_facing_bytes, model_facing_bytes);
    if state.consumed_model_facing_bytes > state.limits.max_cumulative_model_facing_bytes {
        return exhaust(
            state,
            TurnContinuationBudgetTerminalReason::MaxCumulativeModelFacingBytes,
            now,
        );
    }
    state.admitted_requests.push(TurnContinuationAdmission {
        round_id: required_text(round_id).map_err(TurnContinuationBudgetError::Invalid)?,
        request_digest: required_digest(request_digest)
            .map_err(TurnContinuationBudgetError::Invalid)?,
        model_facing_bytes,
    });
    state.last_progress_at_ms = now;
    Ok(state)
}
/// A round that was already admitted, asking again.
#[derive(Clone, Copy)]
struct Readmission {
    same_request: bool,
    admitted_bytes: u64,
    model_facing_bytes: u64,
}

fn readmit(
    mut state: TurnContinuationBudgetState,
    round_id: &str,
    readmission: Readmission,
    now: u64,
) -> Result<TurnContinuationBudgetState, TurnContinuationBudgetError> {
    let Readmission {
        same_request,
        admitted_bytes,
        model_facing_bytes,
    } = readmission;
    if !same_request {
        return exhaust(
            state,
            TurnContinuationBudgetTerminalReason::AdmissionChanged,
            now,
        );
    }
    let observed = integer(model_facing_bytes).map_err(TurnContinuationBudgetError::Invalid)?;
    if observed <= admitted_bytes {
        return Ok(state);
    }
    if observed > state.limits.max_model_facing_bytes {
        return exhaust(
            state,
            TurnContinuationBudgetTerminalReason::ModelFacingBytes,
            now,
        );
    }
    let increment = observed - admitted_bytes;
    state.consumed_model_facing_bytes = safe_add(state.consumed_model_facing_bytes, increment);
    if state.consumed_model_facing_bytes > state.limits.max_cumulative_model_facing_bytes {
        return exhaust(
            state,
            TurnContinuationBudgetTerminalReason::MaxCumulativeModelFacingBytes,
            now,
        );
    }
    if let Some(item) = state
        .admitted_requests
        .iter_mut()
        .find(|item| item.round_id == round_id)
    {
        item.model_facing_bytes = observed;
    }
    state.last_progress_at_ms = now;
    Ok(state)
}

fn exhaust(
    mut state: TurnContinuationBudgetState,
    reason: TurnContinuationBudgetTerminalReason,
    now: u64,
) -> Result<TurnContinuationBudgetState, TurnContinuationBudgetError> {
    state.terminal = Some(TurnContinuationBudgetTerminal {
        code: TURN_CONTINUATION_EXHAUSTED_CODE.to_owned(),
        reason,
        exhausted_at_ms: now,
        extensions: Map::new(),
    });
    Err(TurnContinuationBudgetError::Exhausted(Box::new(state)))
}
fn reason_name(reason: TurnContinuationBudgetTerminalReason) -> &'static str {
    match reason {
        TurnContinuationBudgetTerminalReason::MaxModelRequests => "max_model_requests",
        TurnContinuationBudgetTerminalReason::MaxToolRounds => "max_tool_rounds",
        TurnContinuationBudgetTerminalReason::ModelFacingBytes => "model_facing_bytes",
        TurnContinuationBudgetTerminalReason::MaxCumulativeModelFacingBytes => {
            "max_cumulative_model_facing_bytes"
        }
        TurnContinuationBudgetTerminalReason::MaxOutputBytes => "max_output_bytes",
        TurnContinuationBudgetTerminalReason::MaxElapsedMs => "max_elapsed_ms",
        TurnContinuationBudgetTerminalReason::MaxIdleMs => "max_idle_ms",
        TurnContinuationBudgetTerminalReason::AdmissionChanged => "admission_changed",
    }
}
