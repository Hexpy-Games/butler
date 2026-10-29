//! Runtime-only late-run notice using the user's ordinary prompt time format.
use crate::context::PromptClock;
use butler_turn::btcc::TurnRequest;

pub(super) fn late_notice(
    request: &TurnRequest,
    clock: &dyn PromptClock,
    timezone: &str,
) -> Option<String> {
    let controls = request.execution_controls.as_ref()?.verify().ok()?;
    let due = controls.schedule_run?.scheduled_at?;
    let due_ms = clock.parse_timestamp(&due)?;
    // The admitted message timestamp uses the scheduler's clock, including replay.
    let now_ms = clock
        .parse_timestamp(&request.message.timestamp)
        .unwrap_or_else(|| clock.now_epoch_millis());
    if now_ms.saturating_sub(due_ms) <= butler_core::wall_clock::SCHEDULE_GRACE_MS {
        return None;
    }
    let due = clock.format_local_time(due_ms, timezone).ok()?;
    let now = clock.format_local_time(now_ms, timezone).ok()?;
    Some(format!(
        "This scheduled run was due at {due} but is starting late, at {now}, because Butler could not run it then (for example, the computer was asleep). Cover the whole period up to now, and say briefly in your reply that it ran late."
    ))
}
