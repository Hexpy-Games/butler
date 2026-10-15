//! Scope drive-cache synchronization to a caller's durable transaction.

/// Whether durable SQLite commits require the host drive-cache sync mode.
pub const FULLFSYNC_REQUIRED: bool = cfg!(target_os = "macos");

/// On macOS, request `F_FULLFSYNC` for SQLite syncs during `operation`, then
/// restore the connection policy even when the operation returns an error.
/// The caller must also select `synchronous=FULL` before its transaction.
/// `fullfsync` covers checkpoints too, so `checkpoint_fullfsync` need not change.
/// Other platforms keep SQLite's normal sync implementation with no pragmas.
pub fn with_fullfsync<T>(
    db: &mut rusqlite::Connection,
    operation: impl FnOnce(&mut rusqlite::Connection) -> T,
) -> rusqlite::Result<T> {
    if FULLFSYNC_REQUIRED {
        let previous: bool = db.pragma_query_value(None, "fullfsync", |row| row.get(0))?;
        db.pragma_update(None, "fullfsync", true)?;
        let result = operation(db);
        db.pragma_update(None, "fullfsync", previous)?;
        Ok(result)
    } else {
        Ok(operation(db))
    }
}
