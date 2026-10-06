//! Small indexed projections; rendering a session never scans manifests or blobs.
use super::store::{Output, error};
use rusqlite::{OpenFlags, params};
use std::path::Path;

pub struct OutputSummary {
    pub output_id: String,
    pub session_id: String,
    pub message_id: String,
    pub turn_id: String,
    pub title: String,
    pub size_bytes: u64,
    pub created_at: String,
}
pub(super) fn save(path: &Path, output: &Output) -> std::io::Result<()> {
    let mut connection = butler_platform::sqlite::open(path).map_err(std::io::Error::other)?;
    let db = connection.transaction().map_err(std::io::Error::other)?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS outputs(id TEXT PRIMARY KEY, session TEXT NOT NULL, message TEXT NOT NULL, turn TEXT NOT NULL, title TEXT NOT NULL, bytes INTEGER NOT NULL, created TEXT NOT NULL); CREATE INDEX IF NOT EXISTS outputs_session ON outputs(session); CREATE TABLE IF NOT EXISTS output_refs(id TEXT NOT NULL, session TEXT NOT NULL, turn TEXT NOT NULL, message TEXT NOT NULL, PRIMARY KEY(id,turn)); CREATE INDEX IF NOT EXISTS output_refs_turn ON output_refs(session,turn);").map_err(std::io::Error::other)?;
    let r = output
        .revisions
        .last()
        .ok_or_else(|| error("output_revision_missing"))?;
    db.execute(
        "INSERT OR REPLACE INTO outputs VALUES(?1,?2,?3,?4,?5,?6,?7)",
        params![
            output.output_id,
            output.session_id,
            output.message_id,
            output.turn_id,
            output.title,
            r.size_bytes,
            r.created_at
        ],
    )
    .map_err(std::io::Error::other)?;
    db.execute(
        "INSERT OR REPLACE INTO output_refs VALUES(?1,?2,?3,?4)",
        params![
            output.output_id,
            output.session_id,
            output.turn_id,
            output.message_id
        ],
    )
    .map_err(std::io::Error::other)?;
    db.commit().map_err(std::io::Error::other)
}
pub(super) fn summaries(path: &Path, session: &str) -> std::io::Result<Vec<OutputSummary>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let db = butler_platform::sqlite::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(std::io::Error::other)?;
    if !ready(&db)? {
        return Ok(Vec::new());
    }
    let mut statement = db.prepare("SELECT id,session,message,turn,title,bytes,created FROM outputs WHERE session=?1 ORDER BY id").map_err(std::io::Error::other)?;
    statement
        .query_map([session], |row| {
            Ok(OutputSummary {
                output_id: row.get(0)?,
                session_id: row.get(1)?,
                message_id: row.get(2)?,
                turn_id: row.get(3)?,
                title: row.get(4)?,
                size_bytes: row.get(5)?,
                created_at: row.get(6)?,
            })
        })
        .map_err(std::io::Error::other)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(std::io::Error::other)
}
pub(super) fn remove(path: &Path, session: &str) -> std::io::Result<()> {
    if path.exists() {
        let db = butler_platform::sqlite::open(path).map_err(std::io::Error::other)?;
        db.execute("DELETE FROM output_refs WHERE session=?1", [session])
            .map_err(std::io::Error::other)?;
        db.execute("DELETE FROM outputs WHERE session=?1", [session])
            .map_err(std::io::Error::other)?;
    }
    Ok(())
}

pub(super) fn messages(
    path: &Path,
    session: &str,
    turns: &[String],
) -> std::io::Result<Vec<OutputSummary>> {
    if !path.exists() || turns.is_empty() {
        return Ok(Vec::new());
    }
    let db = butler_platform::sqlite::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(std::io::Error::other)?;
    if !ready(&db)? {
        return Ok(Vec::new());
    }
    let placeholders = std::iter::repeat_n("?", turns.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT o.id,o.session,r.message,r.turn,o.title,o.bytes,o.created FROM output_refs r JOIN outputs o ON o.id=r.id WHERE r.session=? AND r.turn IN ({placeholders}) ORDER BY o.id"
    );
    let mut query = db.prepare(&sql).map_err(std::io::Error::other)?;
    let args = std::iter::once(session).chain(turns.iter().map(String::as_str));
    query
        .query_map(rusqlite::params_from_iter(args), |row| {
            Ok(OutputSummary {
                output_id: row.get(0)?,
                session_id: row.get(1)?,
                message_id: row.get(2)?,
                turn_id: row.get(3)?,
                title: row.get(4)?,
                size_bytes: row.get(5)?,
                created_at: row.get(6)?,
            })
        })
        .map_err(std::io::Error::other)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(std::io::Error::other)
}

// First publication creates both tables in one transaction. Until it commits,
// the file may exist while the index is still logically empty.
fn ready(db: &rusqlite::Connection) -> std::io::Result<bool> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='output_refs')",
        [],
        |row| row.get(0),
    )
    .map_err(std::io::Error::other)
}
