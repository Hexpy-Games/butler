//! Idempotent DDL, applied inside BTCC's existing migration transaction.
use rusqlite::{Connection, OptionalExtension};

/// Creates empty tables/indexes and upgrades store bookkeeping columns. Does
/// not import legacy rows. Runs on the writer lane in the migration transaction.
pub fn ensure(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(include_str!("work_schema/entities.sql"))?;
    connection.execute_batch(include_str!("work_schema/tasks.sql"))?;
    connection.execute_batch(include_str!("work_schema/specs.sql"))?;
    connection.execute_batch(include_str!("work_schema/execution.sql"))?;
    connection.execute_batch(include_str!("work_schema/support.sql"))?;
    for table in ["wm_hold_decisions", "wm_cross_db_intents", "wm_attempts"] {
        ensure_column(
            connection,
            table,
            "revision",
            "INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)",
        )?;
    }
    ensure_column(connection, "wm_attempts", "recovered_at", "INTEGER")?;
    ensure_column(connection, "wm_hold_decisions", "resolved_at", "INTEGER")?;
    let pending: Option<String> = connection
        .query_row(
            "SELECT sql FROM sqlite_schema WHERE type='index' AND name='wm_hold_decisions_pending'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    if pending.is_some_and(|sql| !sql.contains("resolved_at")) {
        connection.execute_batch("DROP INDEX wm_hold_decisions_pending")?;
    }
    connection.execute_batch(include_str!("work_schema/indexes.sql"))
}
fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> rusqlite::Result<()> {
    let present = connection
        .prepare(&format!("PRAGMA table_info({table})"))?
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .iter()
        .any(|name| name == column);
    if !present {
        connection.execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN {column} {definition}"
        ))?;
    }
    Ok(())
}
