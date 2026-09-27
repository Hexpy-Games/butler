use super::{
    AutomationError, AutomationRecord, AutomationSchedule, ClaimedAutomationRun, envelope,
    format_millis, invalid, preview,
};

pub(super) fn claim_record(
    record: &mut AutomationRecord,
    now_ms: i64,
    now: &str,
    parse: &dyn Fn(&str) -> Option<i64>,
) -> Result<ClaimedAutomationRun, AutomationError> {
    let message = envelope(record, now);
    record.run_count = record
        .run_count
        .checked_add(1)
        .ok_or_else(|| invalid("automation run_count is out of range"))?;
    record.last_run_at = Some(now.to_owned());
    record.updated_at = now.to_owned();
    match &record.schedule {
        AutomationSchedule::Once { .. } => {
            record.status = "completed".into();
            record.next_run_at = None;
        }
        AutomationSchedule::Interval {
            interval_minutes,
            start_at,
        } => {
            let interval = interval_minutes
                .checked_mul(60_000)
                .filter(|value| *value > 0)
                .ok_or_else(|| invalid("automation interval_minutes must be at least 1"))?;
            let start = match start_at {
                Some(value) => parse(value)
                    .ok_or_else(|| invalid("automation start_at must be a valid ISO date"))?,
                None => now_ms,
            };
            let skipped = if now_ms < start {
                0
            } else {
                now_ms.saturating_sub(start) / interval + 1
            };
            record.next_run_at = Some(format_millis(
                start.saturating_add(skipped.saturating_mul(interval)),
            )?);
        }
    }
    Ok(ClaimedAutomationRun {
        automation: preview(record),
        envelope: message,
    })
}
