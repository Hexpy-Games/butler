//! Consolidation coalesces missed local occurrences; intents remain recoverable.
use super::{
    consolidation::{ConsolidationRunGate, Schedule},
    daily::DailyCognitionJobs,
    daily_schedule::{iso_at, read_state, write_state},
};
use crate::host::{DateParser, HostError};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

use butler_core::wall_clock::SCHEDULE_GRACE_MS;

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

fn most_recent(schedule: &Schedule, day: &str, now: i64) -> Option<i64> {
    let today = target(&schedule.timezone, day, &schedule.time)?;
    let due = if today <= now {
        today
    } else {
        let yesterday = chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d")
            .ok()?
            .pred_opt()?;
        target(&schedule.timezone, &yesterday.to_string(), &schedule.time)?
    };
    (due <= now && schedule.changed_at.is_none_or(|changed| due > changed)).then_some(due)
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
    let due = most_recent(&schedule, &day, now);
    let occurrence_day = due
        .and_then(|due| schedule.timezone.local_day_and_minute(due).ok())
        .map(|v| v.0);
    let prepared = tokio::task::spawn_blocking(move || {
        prepare(&root, &local_day, now, due, occurrence_day.as_deref())
    })
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
        state["scheduledHandledAtMs"] = json!(now);
        state["skipped"] = json!({"at":iso_at(now),"date":day,"reason":"busy"});
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
    let mut receipt = gate.reserve(&id, "scheduled");
    receipt["scheduledAt"] = intent["scheduledAt"].clone();
    receipt["late"] = intent["late"].clone();
    drop(admission);
    let scheduled_day = intent["scheduledDate"]
        .as_str()
        .ok_or("scheduler_intent_invalid")?
        .to_owned();
    gate.drive(daily, receipt, started, Some(scheduled_day), cancellation)
        .await
}

fn prepare(
    root: &std::path::Path,
    day: &str,
    now: i64,
    due: Option<i64>,
    occurrence_day: Option<&str>,
) -> Result<Option<Value>, HostError> {
    let state = read_state(root, "consolidation-cycle")?;
    let intent = read_state(root, "consolidation-cycle.intent")?;
    // Existing state or an intent already establishes an armed schedule. A fresh
    // data root must not catch up occurrences from before its first evaluation.
    if state.is_none() && intent.is_none() {
        write_state(root, "consolidation-cycle", &json!({"armedAtMs": now}))?;
        return Ok(None);
    }
    // Busy skips retain their current same-day semantics.
    if state
        .as_ref()
        .is_some_and(|s| s["lastRunDate"] == day && s["skipped"]["date"] == day)
    {
        return Ok(None);
    }
    if let Some(intent) = intent
        && !state.as_ref().is_some_and(|s| {
            s["runId"] == intent["runId"]
                || s["scheduledHandledAtMs"]
                    .as_i64()
                    .zip(intent["scheduledAtMs"].as_i64())
                    .is_some_and(|(handled, started)| handled >= started)
        })
    {
        return Ok(Some(intent));
    }
    let Some(due) = due else { return Ok(None) };
    if state.as_ref().is_some_and(|s| {
        s["armedAtMs"].as_i64().is_some_and(|armed| due <= armed)
            || (s["scheduledHandledAtMs"].is_null()
                && s["lastRunDate"]
                    .as_str()
                    .zip(occurrence_day)
                    .is_some_and(|(handled, due)| handled >= due))
            || s["scheduledHandledAtMs"]
                .as_i64()
                .is_some_and(|started| started >= due)
            || (s["trigger"] == "scheduled"
                && s["lastRunAt"]
                    .as_str()
                    .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
                    .is_some_and(|started| started.timestamp_millis() >= due))
    }) {
        return Ok(None);
    }
    let intent = json!({"scheduledDate":occurrence_day,"lastRunAt":iso_at(now),"scheduledAtMs":now,
        "scheduledAt":iso_at(due), "late":now.saturating_sub(due) > SCHEDULE_GRACE_MS,
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
