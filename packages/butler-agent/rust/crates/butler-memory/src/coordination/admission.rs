//! Durable admission exclusions keyed by immutable canonical identifiers.
//! Only reset workers enumerate identifiers; source bodies are never copied.
use butler_platform::sqlite;
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use std::{io, path::Path};

pub(crate) fn capture(
    root: &Path,
    owner: &Connection,
    token: &tokio_util::sync::CancellationToken,
) -> io::Result<()> {
    capture_project(root, owner, token, None)
}

pub(crate) fn capture_project(
    root: &Path,
    owner: &Connection,
    token: &tokio_util::sync::CancellationToken,
    project: Option<&str>,
) -> io::Result<()> {
    owner.execute_batch("CREATE TABLE IF NOT EXISTS memory_reset_admissions(kind TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(kind,id)) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS memory_reset_epochs(epoch TEXT PRIMARY KEY);").map_err(io::Error::other)?;
    let path = root.join("runtime/conversation-store.sqlite");
    super::ensure_data_authority(root, &[&path])?;
    if path.exists() {
        let source = sqlite::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(io::Error::other)?;
        source.execute_batch("BEGIN").map_err(io::Error::other)?;
        for (kind, table) in [
            ("message", "conversation_messages"),
            ("turn", "conversation_turns"),
        ] {
            let mut rows = source
                .prepare(&format!("SELECT m.id FROM {table} m JOIN conversation_sessions s ON s.id=m.session_id WHERE (?1 IS NULL OR s.project_id=?1)"))
                .map_err(io::Error::other)?;
            let ids = rows
                .query_map([project], |row| row.get::<_, String>(0))
                .map_err(io::Error::other)?;
            let mut write = owner
                .prepare("INSERT OR IGNORE INTO memory_reset_admissions(kind,id) VALUES(?1,?2)")
                .map_err(io::Error::other)?;
            for id in ids {
                if token.is_cancelled() {
                    return Err(io::Error::new(io::ErrorKind::Interrupted, "Cancelled"));
                }
                write
                    .execute(params![kind, id.map_err(io::Error::other)?])
                    .map_err(io::Error::other)?;
            }
        }
    }
    owner
        .execute(
            "INSERT INTO memory_reset_epochs(epoch) VALUES(?1)",
            [uuid::Uuid::new_v4().to_string()],
        )
        .map_err(io::Error::other)?;
    Ok(())
}

pub(crate) fn suppressed(db: &Connection, kind: &str, id: &str) -> io::Result<bool> {
    if !has_floor(db)? {
        return Ok(false);
    }
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM memory_reset_admissions WHERE kind=?1 AND id=?2)",
        params![kind, id],
        |row| row.get(0),
    )
    .map_err(io::Error::other)
}

pub(crate) fn has_floor(db: &Connection) -> io::Result<bool> {
    db.query_row(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_reset_admissions'",
        [],
        |_| Ok(()),
    )
    .optional()
    .map(|value| value.is_some())
    .map_err(io::Error::other)
}
