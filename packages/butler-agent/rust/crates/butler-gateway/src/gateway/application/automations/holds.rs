//! Exclude policy waits from lateness while preserving time spent waiting for turns.
use crate::gateway::application::{AppStorageError, initiated::Hold};
use chrono::{DateTime, Duration, SecondsFormat};
use rusqlite::{Connection, OptionalExtension, params};

pub(super) fn record(
    db: &Connection,
    run: &str,
    hold: Hold,
    now: &str,
) -> Result<(), AppStorageError> {
    let until = hold.until();
    let previous: Option<(Option<String>, Option<String>, i64)> = db
        .query_row(
            "SELECT since,until,excluded_ms FROM app_automation_policy_holds WHERE run_id=?1",
            [run],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?;
    if previous.as_ref().is_some_and(|(_, old, _)| old == &until)
        || (previous.is_none() && until.is_none())
    {
        return Ok(());
    }
    let (since, old_until, mut excluded) = previous.unwrap_or_default();
    if let (Some(since), Some(end)) = (since, old_until) {
        let end = end.as_str().min(now);
        excluded += (parse(end)? - parse(&since)?).num_milliseconds().max(0);
    }
    db.execute(
        "INSERT INTO app_automation_policy_holds(run_id,since,until,excluded_ms) VALUES(?1,?2,?3,?4)
         ON CONFLICT(run_id) DO UPDATE SET since=excluded.since,until=excluded.until,excluded_ms=excluded.excluded_ms",
        params![run, until.as_ref().map(|_| now), until, excluded],
    ).map_err(AppStorageError::sqlite)?;
    Ok(())
}

pub(super) fn dispatch_time(
    db: &Connection,
    run: &str,
    now: &str,
) -> Result<String, AppStorageError> {
    let excluded: i64 = db
        .query_row(
            "SELECT excluded_ms FROM app_automation_policy_holds WHERE run_id=?1",
            [run],
            |r| r.get(0),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?
        .unwrap_or(0);
    Ok((parse(now)? - Duration::milliseconds(excluded))
        .with_timezone(&chrono::Utc)
        .to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn parse(at: &str) -> Result<DateTime<chrono::FixedOffset>, AppStorageError> {
    DateTime::parse_from_rfc3339(at).map_err(|_| super::timing::invalid())
}
