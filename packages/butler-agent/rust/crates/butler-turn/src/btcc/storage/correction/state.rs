//! Durable one-time state and cheap read-only retry admission.
use super::*;
use rusqlite::{OptionalExtension, params};
pub(super) const NAME: &str = "acceptance_payload_v1";

pub(super) struct State {
    pub name: Option<String>,
    pub attempts: u32,
    pub queued: u64,
}

pub(super) fn read(db: &rusqlite::Connection) -> StorageResult<State> {
    let row = match db
        .query_row(
            "SELECT state,attempts FROM agent_storage_corrections WHERE name=?1",
            [NAME],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
    {
        Ok(row) => row,
        Err(rusqlite::Error::SqliteFailure(_, Some(message)))
            if message.starts_with("no such table:") =>
        {
            return Ok(State {
                name: None,
                attempts: 0,
                queued: 0,
            });
        }
        Err(e) => return Err(StorageError::sqlite(e)),
    };
    let queued = match db.query_row(
        "SELECT EXISTS(SELECT 1 FROM agent_acceptance_reclaims)",
        [],
        |r| r.get::<_, bool>(0),
    ) {
        Ok(exists) => u64::from(exists),
        Err(rusqlite::Error::SqliteFailure(_, Some(message)))
            if message.starts_with("no such table:") =>
        {
            return Ok(State {
                name: None,
                attempts: 0,
                queued: 0,
            });
        }
        Err(e) => return Err(StorageError::sqlite(e)),
    };
    Ok(match row {
        Some((name, attempts)) => State {
            name: Some(name),
            attempts,
            queued,
        },
        None => State {
            name: None,
            attempts: 0,
            queued,
        },
    })
}

pub(super) fn set(
    db: &rusqlite::Connection,
    state: &str,
    increment: bool,
    detail: &serde_json::Value,
) -> StorageResult<()> {
    db.execute("UPDATE agent_storage_corrections SET state=?1,attempts=attempts+?2,detail_json=?3,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE name=?4", params![state,u32::from(increment),detail.to_string(),NAME]).map_err(StorageError::sqlite)?;
    Ok(())
}

pub(super) struct Pages {
    pub size: u64,
    pub file: u64,
    pub free: u64,
    pub live: u64,
}
pub(super) fn pages(db: &rusqlite::Connection) -> StorageResult<Pages> {
    let size: u64 = db
        .pragma_query_value(None, "page_size", |r| r.get(0))
        .map_err(StorageError::sqlite)?;
    let count: u64 = db
        .pragma_query_value(None, "page_count", |r| r.get(0))
        .map_err(StorageError::sqlite)?;
    let free: u64 = db
        .pragma_query_value(None, "freelist_count", |r| r.get(0))
        .map_err(StorageError::sqlite)?;
    Ok(Pages {
        size,
        file: count * size,
        free: free * size,
        live: (count - free) * size,
    })
}

pub(super) fn worthwhile(p: &Pages) -> bool {
    p.free >= 256 * 1024 * 1024 || (p.free >= 32 * 1024 * 1024 && p.free >= p.file / 2)
}

pub(super) fn admission(
    path: &Path,
    p: &Pages,
    remaining: Duration,
) -> StorageResult<Option<&'static str>> {
    if !worthwhile(p) {
        return Ok(Some("done"));
    }
    if butler_platform::fs_space::available_bytes(parent(path)).map_err(io_error)?
        < p.live.saturating_mul(2).saturating_add(1024 * 1024 * 1024)
    {
        return Ok(Some("pending_space"));
    }
    let seconds = p.live as f64 / 40_000_000.0 + p.live as f64 / 100_000_000.0;
    Ok((seconds > remaining.as_secs_f64()).then_some("pending_time"))
}

pub(super) fn defer(db: &rusqlite::Connection, state: &str, attempts: u32) -> StorageResult<()> {
    if state == "pending_time" && attempts >= 2 {
        set(db, "done", true, &serde_json::json!({"skipped":"slow"}))
    } else {
        set(db, state, state != "done", &serde_json::json!({}))
    }
}
