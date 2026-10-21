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
    connection.execute_batch(include_str!("work_schema/indexes.sql"))
}
