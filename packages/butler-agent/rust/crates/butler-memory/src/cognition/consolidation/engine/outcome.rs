//! Phase outcomes: a phase execution recorded into the checkpoint, and the
//! result of a phase skipped for the rate budget.

use super::*;

/// Records a phase's outcome in the checkpoint about to be committed; the
/// phase result to report.
pub(super) fn record_execution(
    committed: &mut Checkpoint,
    phase: Phase,
    execution: Result<Map<String, Value>, PhaseError>,
    now: &str,
) -> PhaseResult {
    match execution {
        Ok(metrics) => {
            committed.completed_phases.push(phase);
            for error in committed
                .errors
                .iter_mut()
                .filter(|error| error.phase == phase && error.resolved_at.is_none())
            {
                error.resolved_at = Some(now.to_owned());
            }
            PhaseResult {
                phase,
                status: PhaseResultStatus::Ok,
                metrics,
                error: None,
            }
        }
        Err(error) => {
            let safe_message = if error.message == error.code {
                error.code.to_owned()
            } else {
                format!("{}: {}", error.code, error.message)
            };
            committed
                .errors
                .push(CheckpointError::new(phase, safe_message.clone()));
            PhaseResult {
                phase,
                status: PhaseResultStatus::Error,
                metrics: *error.metrics,
                error: Some(safe_message),
            }
        }
    }
}

/// A phase result carrying the rate budget that stopped or deferred it.
pub(super) fn rate_phase(
    phase: Phase,
    status: PhaseResultStatus,
    budget: &RateBudget,
) -> PhaseResult {
    let mut result = PhaseResult::new(phase, status);
    result.metrics = butler_core::json::json_object!({
        "remaining_ratio":budget.remaining_ratio,"reset_at":budget.reset_at,
    });
    result
}
