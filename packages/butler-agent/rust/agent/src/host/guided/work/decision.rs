//! Current durable disposition, not a successful tool result, grants report authority.

use crate::btcc::{
    AcceptedWorkResult, AcceptedWorkStatus, BtccError, DispositionStatus, DurableWorkStatus,
    WorkView, disposition_material_fingerprint,
};

pub(super) enum ReportDecision {
    Report(Option<AcceptedWorkResult>),
    Continue(&'static str),
}

pub(super) fn fresh(work: Option<&WorkView>, turn_id: &str) -> Result<bool, BtccError> {
    let Some(work) = work else { return Ok(true) };
    if work.status == DurableWorkStatus::Abandoned {
        return Ok(true);
    }
    let Some(disposition) = work.latest_disposition.as_ref() else {
        return Ok(false);
    };
    let aligned = matches!(
        (disposition.disposition, work.status),
        (DispositionStatus::Completed, DurableWorkStatus::Completed)
            | (DispositionStatus::Open, DurableWorkStatus::Open)
            | (DispositionStatus::Blocked, DurableWorkStatus::Blocked)
    );
    Ok(disposition.origin_turn_id == turn_id
        && aligned
        && !disposition.material_fingerprint.is_empty()
        && disposition.material_fingerprint == disposition_material_fingerprint(work)?)
}

pub(super) fn decide(
    work: Option<&WorkView>,
    turn_id: &str,
    requires_terminal_result: bool,
) -> Result<ReportDecision, BtccError> {
    let current = fresh(work, turn_id)?;
    if let Some(work) = work.filter(|_| current) {
        if work.status == DurableWorkStatus::Completed {
            return Ok(ReportDecision::Report(Some(AcceptedWorkResult {
                status: AcceptedWorkStatus::Success,
            })));
        }
        if work.status == DurableWorkStatus::Blocked {
            return Ok(ReportDecision::Report(Some(AcceptedWorkResult {
                status: AcceptedWorkStatus::Blocked,
            })));
        }
    }
    if !requires_terminal_result && current {
        return Ok(ReportDecision::Report(None));
    }
    Ok(ReportDecision::Continue(if requires_terminal_result {
        "The delegated assignment is still open. Continue the remaining actions in the same Work and workspace using the current Plan and results. An open disposition saves progress; it does not finish this assignment. When the requested work is done, record completed and report. If a real external blocker prevents further work, record blocked with the reason and report. Use the existing wait or approval flow when waiting is necessary."
    } else {
        "Before reporting the final answer, call record_work_disposition for the explicitly bound Work. Choose completed, open, or blocked with a concise summary and valid action/evidence details, then report."
    }))
}
