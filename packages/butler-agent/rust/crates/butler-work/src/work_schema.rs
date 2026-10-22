//! Idempotent DDL, applied inside BTCC's existing migration transaction.
use rusqlite::Connection;
mod upgrade;

/// Creates empty tables and indexes. Does
/// not import legacy rows. Runs on the writer lane in the migration transaction.
pub fn ensure(connection: &Connection) -> rusqlite::Result<()> {
    check_epoch(connection)?;
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
    upgrade_migration_state(connection)?;
    upgrade_execution(connection)?;
    create(connection)
}
fn upgrade_execution(db: &Connection) -> rusqlite::Result<()> {
    let columns = db
        .prepare("PRAGMA table_info(wm_task_parts)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if !columns.is_empty() && !columns.iter().any(|name| name == "revision") {
        db.execute_batch("ALTER TABLE wm_task_parts ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)")?;
    }
    use rusqlite::OptionalExtension;
    let lease: Option<String> = db
        .query_row(
            "SELECT sql FROM sqlite_schema WHERE name='wm_attempts_lease'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    if lease.is_some_and(|sql| !sql.contains("part_id IS NULL")) {
        db.execute_batch("DROP INDEX wm_attempts_lease")?;
    }
    Ok(())
}
fn create(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(include_str!("work_schema/entities.sql"))?;
    connection.execute_batch(include_str!("work_schema/tasks.sql"))?;
    connection.execute_batch(include_str!("work_schema/specs.sql"))?;
    connection.execute_batch(include_str!("work_schema/execution.sql"))?;
    connection.execute_batch(include_str!("work_schema/support.sql"))?;
    connection.execute_batch(include_str!("work_schema/indexes.sql"))
}

fn upgrade_migration_state(db: &Connection) -> rusqlite::Result<()> {
    use rusqlite::OptionalExtension;
    let ddl: Option<String> = db
        .query_row(
            "SELECT sql FROM sqlite_schema WHERE name='wm_migration'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    if ddl.is_some_and(|ddl| !ddl.contains("failed_backup_copy")) {
        db.execute_batch("ALTER TABLE wm_migration RENAME TO wm_migration_previous")?;
        db.execute_batch(include_str!("work_schema/support.sql"))?;
        db.execute_batch("INSERT INTO wm_migration SELECT * FROM wm_migration_previous; DROP TABLE wm_migration_previous")?;
    }
    Ok(())
}

/// The only Work writer epoch this build understands.
pub const WRITER_EPOCH: i64 = 1;

/// Refuse newer writers before any schema migration mutates their database.
pub fn check_epoch(db: &Connection) -> rusqlite::Result<()> {
    use rusqlite::OptionalExtension;
    let exists = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='wm_migration')",
        [],
        |r| r.get::<_, bool>(0),
    )?;
    if exists {
        let epoch = db
            .query_row(
                "SELECT writer_epoch FROM wm_migration WHERE singleton=1",
                [],
                |r| r.get::<_, i64>(0),
            )
            .optional()?;
        if epoch.is_some_and(|epoch| epoch > WRITER_EPOCH) {
            return Err(rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_ERROR),Some("This data folder was written by a newer Butler build; update Butler before opening it".into())));
        }
    }
    Ok(())
}
