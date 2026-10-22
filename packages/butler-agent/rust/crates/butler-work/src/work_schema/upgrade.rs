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
