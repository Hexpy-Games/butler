//! Forward canon migration inside BTCC's single IMMEDIATE transaction.
use rusqlite::Connection;
mod upgrade;

pub fn ensure(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch("SAVEPOINT canon_schema")?;
    let deferred: bool = connection.pragma_query_value(None, "defer_foreign_keys", |r| r.get(0))?;
    connection.pragma_update(None, "defer_foreign_keys", true)?;
    let result = create(connection).and_then(|()| upgrade::merged(connection));
    let result = result.and_then(|()| {
        if connection
            .prepare("PRAGMA foreign_key_check")?
            .query([])?
            .next()?
            .is_some()
        {
            return Err(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT_FOREIGNKEY),
                Some("canon migration violates foreign keys".into()),
            ));
        }
        Ok(())
    });
    if result.is_err() {
        connection.execute_batch("ROLLBACK TO canon_schema")?;
    }
    connection.pragma_update(None, "defer_foreign_keys", deferred)?;
    connection.execute_batch("RELEASE canon_schema")?;
    result
}
fn create(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(include_str!("work_schema/entities.sql"))?;
    connection.execute_batch(include_str!("work_schema/specs.sql"))?;
    connection.execute_batch(include_str!("work_schema/support.sql"))?;
    connection.execute_batch(include_str!("work_schema/indexes.sql"))
}
