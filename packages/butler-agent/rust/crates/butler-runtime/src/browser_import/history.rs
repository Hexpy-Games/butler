//! Visit parsing shares detected profiles and the private DB/WAL snapshot.
use butler_platform::{
    browser_profiles::{BookmarkFormat, BrowserProfile, ProfileAccess},
    browser_transfer::{ImportError, Snapshot, io_error, sql_error},
};
use rusqlite::{Connection, OpenFlags, params};
use serde_json::{Value, json};
use std::path::Path;

/// Last 180 days, in chronological order; only public web URLs reach storage.
pub fn history(profile: &BrowserProfile, scratch: &Path) -> Result<Vec<Value>, ImportError> {
    if profile.access == ProfileAccess::PermissionDenied {
        return Err(ImportError::PermissionDenied);
    }
    let dir = profile.bookmarks.parent().ok_or(ImportError::NotFound)?;
    let (path, sql, epoch, units) = match profile.format {
        BookmarkFormat::Chromium => (
            dir.join("History"),
            "SELECT u.url,COALESCE(u.title,''),v.visit_time FROM visits v JOIN urls u ON u.id=v.url WHERE v.visit_time>=?1 AND v.visit_time<=?2 ORDER BY v.visit_time,v.id",
            11_644_473_600_000_i64,
            1000.0,
        ),
        BookmarkFormat::Firefox => (
            dir.join("places.sqlite"),
            "SELECT p.url,COALESCE(p.title,''),v.visit_date FROM moz_historyvisits v JOIN moz_places p ON p.id=v.place_id WHERE v.visit_date>=?1 AND v.visit_date<=?2 ORDER BY v.visit_date,v.id",
            0,
            1000.0,
        ),
        BookmarkFormat::Safari => (
            dir.join("History.db"),
            "SELECT i.url,COALESCE(v.title,''),v.visit_time FROM history_visits v JOIN history_items i ON i.id=v.history_item WHERE v.visit_time>=?1 AND v.visit_time<=?2 ORDER BY v.visit_time,v.id",
            -978_307_200_000,
            0.001,
        ),
    };
    if !path.try_exists().map_err(|e| io_error(&e))? {
        return Ok(Vec::new());
    }
    let snapshot = Snapshot::new(&path, scratch)?;
    let db = Connection::open_with_flags(&snapshot.path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| sql_error(&e))?;
    let now = chrono::Utc::now().timestamp_millis();
    let since = now - 180 * 86_400_000;
    let mut statement = db.prepare(sql).map_err(|e| sql_error(&e))?;
    let rows = statement
        .query_map(
            params![(since + epoch) as f64 * units, (now + epoch) as f64 * units],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    timestamp(r, profile.format)?,
                ))
            },
        )
        .map_err(|e| sql_error(&e))?;
    let mut visits = Vec::new();
    for row in rows {
        let (raw, title, time) = row.map_err(|e| sql_error(&e))?;
        let Ok(url) = url::Url::parse(&raw) else {
            continue;
        };
        if !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
        {
            continue;
        }
        let Some(time) = chrono::DateTime::from_timestamp_millis(time) else {
            continue;
        };
        visits.push(json!({"url":url.as_str(),"title":title,"visitedAt":time.to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"tabKind":"mine"}));
    }
    Ok(visits)
}

#[allow(
    clippy::cast_possible_truncation,
    reason = "Safari stores fractional seconds; the SQL interval bounds the rounded milliseconds"
)]
fn timestamp(row: &rusqlite::Row<'_>, format: BookmarkFormat) -> rusqlite::Result<i64> {
    Ok(match format {
        BookmarkFormat::Safari => (row.get::<_, f64>(2)? * 1000.0).round() as i64 + 978_307_200_000,
        BookmarkFormat::Chromium => row.get::<_, i64>(2)? / 1000 - 11_644_473_600_000,
        BookmarkFormat::Firefox => row.get::<_, i64>(2)? / 1000,
    })
}
