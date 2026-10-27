//! Resolve only the most recent missed occurrence, without replaying the backlog.
use super::{records::AutomationRow, timing};
use crate::gateway::application::{
    AppApplication, AppStorageError, GatewayApplicationError, app_error,
};
use chrono::{DateTime, Duration, SecondsFormat};

pub(super) fn latest(row: &AutomationRow, now: &str) -> Result<Option<String>, AppStorageError> {
    let Some(first) = row.next.as_deref() else {
        return Ok(None);
    };
    let first_time = DateTime::parse_from_rfc3339(first).map_err(|_| timing::invalid())?;
    let now_time = DateTime::parse_from_rfc3339(now).map_err(|_| timing::invalid())?;
    if let Some(rule) = &row.schedule {
        // A weekly recurrence has a slot in the preceding fortnight even across DST.
        let mut cursor = (now_time - Duration::days(15)).to_rfc3339();
        let mut latest = first.to_owned();
        for _ in 0..16 {
            let next = timing::next(rule, &cursor)?;
            let time = DateTime::parse_from_rfc3339(&next).map_err(|_| timing::invalid())?;
            if time > now_time {
                break;
            }
            if time >= first_time {
                latest = next.clone();
            }
            cursor = next;
        }
        return Ok(Some(latest));
    }
    if row.schedule_type == "once" || now_time < first_time {
        return Ok(Some(first.into()));
    }
    let step = row
        .interval
        .checked_mul(1000)
        .filter(|v| *v > 0)
        .ok_or_else(timing::invalid)?;
    let elapsed = (now_time - first_time).num_milliseconds();
    let due = now_time - Duration::milliseconds(elapsed.rem_euclid(step));
    Ok(Some(due.to_rfc3339_opts(SecondsFormat::Millis, true)))
}

pub(super) fn is_late(due: Option<&str>, now: &str) -> bool {
    due.and_then(|due| {
        Some((
            DateTime::parse_from_rfc3339(due).ok()?,
            DateTime::parse_from_rfc3339(now).ok()?,
        ))
    })
    .is_some_and(|(due, now)| {
        (now - due).num_milliseconds() > butler_core::wall_clock::SCHEDULE_GRACE_MS
    })
}

impl AppApplication {
    pub(super) async fn schedule_context(
        &self,
        id: &str,
        run_id: &str,
        trigger: &str,
    ) -> Result<butler_turn::btcc::ScheduleRunContext, GatewayApplicationError> {
        let run = run_id.to_owned();
        let now = self.dependencies.identity_clock.now_iso();
        let scheduled_at = self
            .storage
            .execute(move |db| {
                let record = super::records::run(db, &run)?;
                let scheduled_at = record.scheduled_at;
                let dispatch = super::holds::dispatch_time(db, &run, &now)?;
                let late = is_late(scheduled_at.as_deref(), &dispatch);
                db.execute(
                    "UPDATE app_automation_runs SET late=?1 WHERE id=?2",
                    rusqlite::params![late, run],
                )
                .map_err(AppStorageError::sqlite)?;
                let schedule = super::records::active(db, &record.automation_id)?;
                Ok((
                    scheduled_at,
                    butler_turn::btcc::ScheduleBrowserOptions {
                        signin: schedule.browser_signin,
                        payment: schedule.browser_payment,
                    },
                ))
            })
            .await
            .map_err(app_error)?;
        Ok(butler_turn::btcc::ScheduleRunContext {
            automation_id: id.into(),
            run_id: run_id.into(),
            unattended: trigger == "scheduled",
            connector_event: false,
            scheduled_at: scheduled_at.0,
            browser: Some(scheduled_at.1),
        })
    }
}
