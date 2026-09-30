//! Resolve only indexed relation parents; never enrich the entire App catalog.
use super::super::sessions::read;
use super::super::storage::AppStorageError;
use crate::gateway::AppSessionSummary;
use rusqlite::Connection;

pub(super) fn resolve(
    db: &Connection,
    parents: &[String],
) -> Result<Vec<AppSessionSummary>, AppStorageError> {
    let mut sessions = Vec::new();
    for parent in parents {
        let mut statement = db.prepare_cached(
            "SELECT c.id FROM chats c WHERE c.id IN (SELECT id FROM chats WHERE id=?1 UNION SELECT chat_id FROM app_work_monitor WHERE runtime_session_id=?1) AND c.archived=0 \
            AND NOT EXISTS(SELECT 1 FROM app_session_branches b WHERE b.target_session_id=c.id AND b.state='prepared') \
            ORDER BY c.pinned DESC,c.updated_at DESC,c.created_at DESC",
            ).map_err(AppStorageError::sqlite)?;
        let ids = statement
            .query_map([parent], |row| row.get::<_, String>(0))
            .map_err(AppStorageError::sqlite)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(AppStorageError::sqlite)?;
        for id in ids {
            sessions.push(read::session(db, &id)?);
        }
    }
    Ok(sessions)
}
