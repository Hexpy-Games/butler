//! P1 was never released: preserve Works and discard only provisional Task data.
use rusqlite::Connection;

pub(super) fn p1(connection: &Connection) -> rusqlite::Result<()> {
    let old: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('wm_works') WHERE name='chain_id')
         OR EXISTS(SELECT 1 FROM sqlite_schema WHERE name='wm_work_chains')",
        [],
        |row| row.get(0),
    )?;
    if !old {
        return Ok(());
    }
    let deferred: bool = connection.pragma_query_value(None, "defer_foreign_keys", |r| r.get(0))?;
    connection.pragma_update(None, "defer_foreign_keys", true)?;
    let result = rebuild(connection)
        .and_then(|()| super::create(connection))
        .and_then(|()| {
            // Turning deferral off discards deferred violations; validate first.
            if connection
                .prepare("PRAGMA foreign_key_check")?
                .query([])?
                .next()?
                .is_some()
            {
                return Err(rusqlite::Error::SqliteFailure(
                    rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT_FOREIGNKEY),
                    Some("work-model rebuild violates foreign keys".into()),
                ));
            }
            Ok(())
        });
    let restored = connection.pragma_update(None, "defer_foreign_keys", deferred);
    result.and(restored)
}
fn rebuild(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "UPDATE wm_session_exec SET current_task_id=NULL;
        DROP TABLE IF EXISTS wm_reviews;
        DROP TABLE IF EXISTS wm_results;
        DROP TABLE IF EXISTS wm_attempts;
        DROP TABLE IF EXISTS wm_task_criteria;
        DROP TABLE IF EXISTS wm_task_edges;
        DROP TABLE IF EXISTS wm_tasks;
        DROP TABLE IF EXISTS wm_work_edges;
        DROP TABLE IF EXISTS wm_hold_decisions;",
    )?;
    connection.execute_batch(
        "CREATE TEMP TABLE wm_works_upgrade_rows AS SELECT * FROM wm_works;
        DROP TABLE wm_works;",
    )?;
    connection.execute_batch(include_str!("entities.sql"))?;
    connection.execute_batch("INSERT INTO wm_works
        (id,scope_kind,scope_ref,plan_id,home_session_id,spec_node_id,title,description,kind,
         run_generation,run_state,canon_status,canon_status_source,assignee,plan_rank,
         failure_reason,draft,tier,visibility,origin,import_note,revision,created_at,updated_at,created_by)
        SELECT id,scope_kind,scope_ref,plan_id,home_session_id,spec_node_id,title,description,kind,
         run_generation,CASE WHEN run_state IN ('done','cancelled','paused','stopped') THEN run_state ELSE 'idle' END,
         canon_status,canon_status_source,assignee,plan_rank,NULL,draft,tier,visibility,
         origin,import_note,revision,created_at,updated_at,created_by FROM wm_works_upgrade_rows;
        DROP TABLE wm_works_upgrade_rows;
        DROP TABLE IF EXISTS wm_work_chains;
        DELETE FROM wm_counts WHERE key='works' OR key LIKE 'run_state:%';")
}

/// Preserve every cutover row and referencing id while installing owner CHECKs.
pub(super) fn p2_2(db: &Connection) -> rusqlite::Result<()> {
    if has_table(db, "wm_tasks")? && !has_column(db, "wm_tasks", "reserved_session_id")? {
        rebuild_tasks(db)?;
    }
    for (table, column, definition) in [
        ("wm_attempts", "owner_epoch", "INTEGER NOT NULL DEFAULT 0"),
        ("wm_works", "started_at", "INTEGER"),
        ("wm_holds", "reason", "TEXT"),
    ] {
        if has_table(db, table)? && !has_column(db, table, column)? {
            db.execute_batch(&format!(
                "ALTER TABLE {table} ADD COLUMN {column} {definition}"
            ))?;
        }
    }
    Ok(())
}
fn has_table(db: &Connection, table: &str) -> rusqlite::Result<bool> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name=?1 AND type='table')",
        [table],
        |r| r.get(0),
    )
}
fn has_column(db: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name=?2)",
        [table, column],
        |r| r.get(0),
    )
}
fn rebuild_tasks(db: &Connection) -> rusqlite::Result<()> {
    let deferred: bool = db.pragma_query_value(None, "defer_foreign_keys", |r| r.get(0))?;
    db.pragma_update(None, "defer_foreign_keys", true)?;
    let result = copy_tasks(db).and_then(|()| {
        if db
            .prepare("PRAGMA foreign_key_check")?
            .query([])?
            .next()?
            .is_some()
        {
            return Err(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT_FOREIGNKEY),
                Some("task ownership rebuild violates foreign keys".into()),
            ));
        }
        Ok(())
    });
    let restored = db.pragma_update(None, "defer_foreign_keys", deferred);
    result.and(restored)
}
fn copy_tasks(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch(
        "CREATE TEMP TABLE wm_tasks_upgrade_rows AS SELECT * FROM wm_tasks;
        DROP TABLE wm_tasks;",
    )?;
    db.execute_batch(include_str!("tasks.sql"))?;
    db.execute_batch(
        "INSERT INTO wm_tasks
        (id,work_id,spec_ref,title,description,status,assignee_session_id,blocked_reason,
         supersedes_task_id,completion_revision,chain_id,step_index,stack_position,
         hold_reason,held_by_task_id,failure_reason,result_reported_at,origin,
         origin_message_id,historical,revision,created_at,updated_at,created_by)
        SELECT id,work_id,spec_ref,title,description,status,assignee_session_id,blocked_reason,
         supersedes_task_id,completion_revision,chain_id,step_index,stack_position,
         hold_reason,held_by_task_id,failure_reason,result_reported_at,origin,
         origin_message_id,historical,revision,created_at,updated_at,created_by
         FROM wm_tasks_upgrade_rows;
        DROP TABLE wm_tasks_upgrade_rows;",
    )
}
