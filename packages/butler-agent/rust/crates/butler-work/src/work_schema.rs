//! Idempotent DDL, applied inside BTCC's existing migration transaction.
use rusqlite::Connection;
mod upgrade;

/// Creates empty tables and indexes. Does
/// not import legacy rows. Runs on the writer lane in the migration transaction.
pub fn ensure(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch("SAVEPOINT wm_schema")?;
    let result = target(connection);
    match result {
        Ok(()) => connection.execute_batch("RELEASE wm_schema"),
        Err(error) => {
            connection.execute_batch("ROLLBACK TO wm_schema; RELEASE wm_schema")?;
            Err(error)
        }
    }
}
fn target(connection: &Connection) -> rusqlite::Result<()> {
    upgrade::p1(connection)?;
    connection.execute_batch(include_str!("work_schema/entities.sql"))?;
    connection.execute_batch(include_str!("work_schema/tasks.sql"))?;
    connection.execute_batch(include_str!("work_schema/specs.sql"))?;
    connection.execute_batch(include_str!("work_schema/execution.sql"))?;
    connection.execute_batch(include_str!("work_schema/support.sql"))?;
    connection.execute_batch(include_str!("work_schema/indexes.sql"))
}
