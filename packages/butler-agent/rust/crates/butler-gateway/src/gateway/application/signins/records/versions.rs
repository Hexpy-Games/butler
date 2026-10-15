//! Indexed credential revisions and undo metadata. Secrets live in the keychain.
use super::{Result, sql};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

pub(super) fn millis(time: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(time)
        .map(|t| t.timestamp_millis())
        .unwrap_or(0)
}
pub(super) fn latest(db: &Connection, id: &str) -> Result<i64> {
    let (created, used): (String, Option<String>) = db
        .query_row(
            "SELECT created_at,last_used_at FROM browser_signin_entries WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(sql)?;
    let version: Option<i64> = db
        .query_row(
            "SELECT modified_ms FROM browser_signin_versions WHERE entry_id=?1",
            [id],
            |r| r.get(0),
        )
        .optional()
        .map_err(sql)?;
    Ok(version
        .unwrap_or_else(|| millis(&created))
        .max(used.as_deref().map(millis).unwrap_or(0)))
}
pub(super) fn set(db: &Connection, id: &str, time: i64, revision: &str) -> Result<()> {
    db.execute("INSERT INTO browser_signin_versions VALUES(?1,?2,?3) ON CONFLICT(entry_id) DO UPDATE SET modified_ms=excluded.modified_ms,revision=excluded.revision", params![id,time,revision]).map_err(sql)?;
    Ok(())
}
pub(super) fn finish(db: &Connection, id: &str, run: &str, time: i64) -> Result<Value> {
    let previous = latest(db, id)?;
    let revision: String = db
        .query_row(
            "SELECT revision FROM browser_signin_versions WHERE entry_id=?1",
            [id],
            |r| r.get(0),
        )
        .optional()
        .map_err(sql)?
        .unwrap_or_default();
    let next = uuid::Uuid::new_v4().to_string();
    db.execute("INSERT INTO browser_import_updates VALUES(?1,?2,?3,?4,?5) ON CONFLICT(run_id,entry_id) DO UPDATE SET revision=excluded.revision", params![run,id,previous,revision,next]).map_err(sql)?;
    set(db, id, time, &next)?;
    Ok(json!({"ok":true}))
}
pub(super) fn restore(db: &Connection, id: &str, run: &str) -> Result<Value> {
    let previous: Option<(i64,String)> = db.query_row("SELECT u.previous_ms,u.previous_revision FROM browser_import_updates u JOIN browser_signin_versions v ON v.entry_id=u.entry_id AND v.revision=u.revision WHERE u.run_id=?1 AND u.entry_id=?2",params![run,id],|r| Ok((r.get(0)?,r.get(1)?))).optional().map_err(sql)?;
    if let Some((time, revision)) = &previous {
        set(db, id, *time, revision)?;
    }
    db.execute(
        "DELETE FROM browser_import_updates WHERE run_id=?1 AND entry_id=?2",
        params![run, id],
    )
    .map_err(sql)?;
    Ok(json!({"restored":previous.is_some()}))
}
