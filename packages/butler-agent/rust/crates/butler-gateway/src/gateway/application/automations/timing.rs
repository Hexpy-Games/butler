//! Calendar recurrences are evaluated only on creation, edits and runs.
use std::path::{Component, Path};

use chrono::{DateTime, Datelike, Duration, NaiveTime, SecondsFormat, Timelike, Utc};

use super::CalendarSchedule;
use crate::gateway::application::storage::{AppStorageCode, AppStorageError};

pub(super) fn invalid() -> AppStorageError {
    AppStorageError::new(
        AppStorageCode::AutomationIntervalInvalid,
        "Schedule timing is invalid.",
    )
}

pub(super) fn next(rule: &CalendarSchedule, now: &str) -> Result<String, AppStorageError> {
    let path = Path::new(&rule.tz);
    if rule.tz.is_empty()
        || rule.tz.len() > 100
        || path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(invalid());
    }
    let bytes = butler_platform::time_zone::zone_rules(&rule.tz).map_err(|_| invalid())?;
    let zone = tz::TimeZone::from_tz_data(&bytes).map_err(|_| invalid())?;
    compute(rule, now, &zone)
}

fn compute(
    rule: &CalendarSchedule,
    now: &str,
    zone: &tz::TimeZone,
) -> Result<String, AppStorageError> {
    if !matches!(rule.kind.as_str(), "daily" | "weekly")
        || (rule.kind == "weekly" && rule.weekdays.is_empty())
        || rule.weekdays.iter().any(|day| !(1..=7).contains(day))
        || rule.time.len() != 5
    {
        return Err(invalid());
    }
    let time = NaiveTime::parse_from_str(&rule.time, "%H:%M").map_err(|_| invalid())?;
    let now = DateTime::parse_from_rfc3339(now).map_err(|_| invalid())?;
    let offset = zone
        .find_local_time_type(now.timestamp())
        .map_err(|_| invalid())?
        .ut_offset();
    let today = now
        .naive_utc()
        .checked_add_signed(Duration::seconds(i64::from(offset)))
        .ok_or_else(invalid)?
        .date();
    for days in 0..=14 {
        let date = today
            .checked_add_signed(Duration::days(days))
            .ok_or_else(invalid)?;
        if rule.kind == "weekly"
            && !rule.weekdays.contains(
                &(u8::try_from(date.weekday().number_from_monday()).map_err(|_| invalid())?),
            )
        {
            continue;
        }
        let found = tz::DateTime::find(
            date.year(),
            u8::try_from(date.month()).map_err(|_| invalid())?,
            u8::try_from(date.day()).map_err(|_| invalid())?,
            u8::try_from(time.hour()).map_err(|_| invalid())?,
            u8::try_from(time.minute()).map_err(|_| invalid())?,
            0,
            0,
            zone.as_ref(),
        )
        .map_err(|_| invalid())?;
        // Skip nonexistent wall times. In a fall-back overlap, use the first
        // occurrence only, so completing a run cannot schedule it twice.
        let first = found
            .into_inner()
            .into_iter()
            .filter_map(|candidate| match candidate {
                tz::datetime::FoundDateTimeKind::Normal(value) => Some(value.unix_time()),
                tz::datetime::FoundDateTimeKind::Skipped { .. } => None,
            })
            .min();
        if let Some(epoch) = first.filter(|epoch| *epoch > now.timestamp()) {
            return DateTime::<Utc>::from_timestamp(epoch, 0)
                .map(|value| value.to_rfc3339_opts(SecondsFormat::Millis, true))
                .ok_or_else(invalid);
        }
    }
    Err(invalid())
}

#[cfg(test)]
mod tests {
    use super::*;

    // test-category: pure-logic
    #[test]
    fn next_run_respects_local_days_gaps_and_overlaps() -> Result<(), AppStorageError> {
        let zone = tz::TimeZone::from_tz_data(include_bytes!("fixtures/new-york.tzif"))
            .map_err(|_| invalid())?;
        let mut rule = CalendarSchedule {
            kind: "daily".into(),
            time: "08:00".into(),
            weekdays: vec![],
            tz: "America/New_York".into(),
        };
        for (now, expected) in [
            ("2026-03-07T14:00:00Z", "2026-03-08T12:00:00.000Z"),
            ("2026-03-08T11:00:00Z", "2026-03-08T12:00:00.000Z"),
            ("2026-11-01T00:00:00Z", "2026-11-01T13:00:00.000Z"),
        ] {
            assert_eq!(compute(&rule, now, &zone)?, expected);
        }
        rule.time = "02:30".into();
        assert_eq!(
            compute(&rule, "2026-03-08T05:00:00Z", &zone)?,
            "2026-03-09T06:30:00.000Z"
        );
        rule.time = "01:30".into();
        assert_eq!(
            compute(&rule, "2026-11-01T05:30:00Z", &zone)?,
            "2026-11-02T06:30:00.000Z"
        );
        rule.kind = "weekly".into();
        rule.weekdays = vec![1, 2, 3, 4, 5];
        rule.time = "08:00".into();
        assert_eq!(
            compute(&rule, "2026-03-06T14:00:00Z", &zone)?,
            "2026-03-09T12:00:00.000Z"
        );
        rule.weekdays = vec![1];
        assert_eq!(
            compute(&rule, "2026-03-09T12:00:00Z", &zone)?,
            "2026-03-16T12:00:00.000Z"
        );
        Ok(())
    }
}
