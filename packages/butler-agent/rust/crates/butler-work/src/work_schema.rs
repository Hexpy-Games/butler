//! Idempotent DDL, applied inside BTCC's existing migration transaction.
use rusqlite::Connection;

/// Creates only empty tables and indexes. Does not import or mutate legacy rows.
/// Call on the storage writer lane, inside the caller's migration transaction.
pub fn ensure(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(include_str!("work_schema/entities.sql"))?;
    connection.execute_batch(include_str!("work_schema/tasks.sql"))?;
    connection.execute_batch(include_str!("work_schema/specs.sql"))?;
    connection.execute_batch(include_str!("work_schema/execution.sql"))?;
    connection.execute_batch(include_str!("work_schema/support.sql"))?;
    connection.execute_batch(include_str!("work_schema/indexes.sql"))?;
    for table in ["wm_hold_decisions", "wm_cross_db_intents", "wm_attempts"] {
        let present = connection
            .prepare(&format!("PRAGMA table_info({table})"))?
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .iter()
            .any(|name| name == "revision");
        if !present {
            connection.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)"))?;
        }
    }
    let recovered = connection
        .prepare("PRAGMA table_info(wm_attempts)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .iter()
        .any(|name| name == "recovered_at");
    if !recovered {
        connection.execute_batch("ALTER TABLE wm_attempts ADD COLUMN recovered_at INTEGER")?;
    }
    Ok(())
}
