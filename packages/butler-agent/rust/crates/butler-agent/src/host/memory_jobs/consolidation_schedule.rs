//! Consolidation alone uses a bounded local-time window; intents remain recoverable.
use super::{
    consolidation::{ConsolidationRunGate, Schedule},
    daily::DailyCognitionJobs,
    daily_schedule::{iso_at, read_state, write_state},
};
use crate::host::{DateParser, HostError};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

const GRACE_MS: i64 = 2 * 60_000;

/// Resolve the first occurrence, advancing through a DST gap to its first valid minute.
pub(super) fn target(timezone: &DateParser, day: &str, time: &str) -> Option<i64> {
    let (hour, minute) = time.split_once(':')?;
    let minute = hour
        .parse::<u16>()
        .ok()?
        .checked_mul(60)?
        .checked_add(minute.parse().ok()?)?;
    for wall in minute..1440 {
        let candidate = timezone.parse(&format!("{day}T{:02}:{:02}:00", wall / 60, wall % 60))?;
        if timezone.local_day_and_minute(candidate).ok()? == (day.to_owned(), wall) {
            return Some(candidate);
        }
    }
    None
}

pub(super) fn in_window(timezone: &DateParser, day: &str, now: i64, schedule: &Schedule) -> bool {
    target(timezone, day, &schedule.time).is_some_and(|due| {
        schedule.changed_at.is_none_or(|changed| due > changed)
            && (due..=due.saturating_add(GRACE_MS)).contains(&now)
    })
}

pub(super) async fn run_due(
    daily: &DailyCognitionJobs,
    now: i64,
    cancellation: &CancellationToken,
) -> Result<(), HostError> {
    if cancellation.is_cancelled() {
        return Ok(());
    }
    let gate = &daily.gate;
    let admission = gate.admission.lock().await;
    let schedule = gate.schedule();
    let (day, _) = schedule
        .timezone
        .local_day_and_minute(now)
        .map_err(HostError::from_error)?;
    let root = daily.data_root().to_owned();
    let local_day = day.clone();
    let window = in_window(&schedule.timezone, &day, now, &schedule);
    let prepared = tokio::task::spawn_blocking(move || prepare(&root, &local_day, now, window))
        .await
        .map_err(HostError::from_error)??;
    let Some(intent) = prepared else {
        return Ok(());
    };
    if gate.active().is_some()
        || !gate
            .jobs
            .lock()
            .map_err(|_| HostError::new("memory_jobs_poisoned"))?
            .is_empty()
    {
        let mut state = gate.state().await?.unwrap_or(json!({}));
        state["lastRunDate"] = json!(day);
        state["skipped"] = json!({"at":iso_at(now),"reason":"busy"});
        gate.persist(state).await?;
        return Ok(());
    }
    let id = intent["runId"]
        .as_str()
        .ok_or("scheduler_intent_invalid")?
        .to_owned();
    let started = intent["scheduledAtMs"]
        .as_i64()
        .ok_or("scheduler_intent_invalid")?;
    let receipt = gate.reserve(&id, "scheduled");
    drop(admission);
    gate.drive(daily, receipt, started, Some(day), cancellation)
        .await
}

fn prepare(
    root: &std::path::Path,
    day: &str,
    now: i64,
    window: bool,
) -> Result<Option<Value>, HostError> {
    if read_state(root, "consolidation-cycle")?.is_some_and(|s| s["lastRunDate"] == day) {
        return Ok(None);
    }
    if let Some(intent) = read_state(root, "consolidation-cycle.intent")?
        && intent["scheduledDate"] == day
    {
        return Ok(Some(intent));
    }
    if !window {
        return Ok(None);
    }
    let intent = json!({"scheduledDate":day,"lastRunAt":iso_at(now),"scheduledAtMs":now,
        "runId":format!("cr_scheduled_{}",uuid::Uuid::new_v4().simple()),"status":"pending"});
    write_state(root, "consolidation-cycle.intent", &intent)?;
    Ok(Some(intent))
}

/// Next boundary, retaining the fixed session-sync and context-maintenance wakeups.
pub(super) fn next_delay(
    timezone: &DateParser,
    now: i64,
    gate: &Arc<ConsolidationRunGate>,
) -> std::time::Duration {
    let fixed = super::context_maintenance::next_tick_delay(timezone, now);
    let schedule = gate.schedule();
    let timezone = &schedule.timezone;
    let Ok((day, _)) = timezone.local_day_and_minute(now) else {
        return fixed;
    };
    // Tomorrow is resolved through the same timezone, including 23/25-hour days.
    let mut best = fixed;
    for candidate_day in [
        Some(day),
        timezone
            .local_day_and_minute(now.saturating_add(86_400_000))
            .ok()
            .map(|v| v.0),
    ]
    .into_iter()
    .flatten()
    {
        if let Some(due) = target(timezone, &candidate_day, &schedule.time)
            && due > now
        {
            best = best.min(std::time::Duration::from_millis(
                u64::try_from(due - now).unwrap_or_default(),
            ));
        }
    }
    best
}
