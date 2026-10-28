//! Forward canon migration inside BTCC's single IMMEDIATE transaction.
use rusqlite::Connection;
mod upgrade;

pub fn ensure(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch("SAVEPOINT canon_schema")?;
    let deferred: bool = connection.pragma_query_value(None, "defer_foreign_keys", |r| r.get(0))?;
    connection.pragma_update(None, "defer_foreign_keys", true)?;
    let result = create(connection).and_then(|()| upgrade::merged(connection));
    let result = result.and_then(|copied| {
        if copied {
            check_canon(connection)?;
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
    connection.execute_batch(include_str!("work_schema/tags.sql"))?;
    connection.execute_batch(include_str!("work_schema/support.sql"))?;
    connection.execute_batch(include_str!("work_schema/proposals.sql"))?;
    let had_chains: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='canon_session_queue_chains')", [], |r|r.get(0))?;
    connection.execute_batch(include_str!("work_schema/queue.sql"))?;
    if !had_chains {
        connection.execute_batch("INSERT INTO canon_session_queue_chains(session_id,chain_id,plan_id)
            SELECT q.session_id,q.chain_id,COALESCE(MIN(json_extract(i.payload_json,'$.plan_id')),CASE WHEN COUNT(DISTINCT e.plan_id)=1 THEN MIN(e.plan_id) END)
            FROM canon_session_queue q INDEXED BY canon_queue_active_epic JOIN canon_epics e ON e.id=q.epic_id LEFT JOIN canon_intents i ON i.op_id=q.step_op_id
            WHERE q.state IN ('waiting','running','held') GROUP BY q.session_id,q.chain_id")?;
    }
    let mut stmt = connection.prepare("PRAGMA table_info(canon_epic_work_links)")?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if !columns.iter().any(|name| name == "reported_applied") {
        connection.execute_batch("ALTER TABLE canon_epic_work_links ADD COLUMN reported_applied INTEGER NOT NULL DEFAULT 0 CHECK (reported_applied IN (0,1))")?;
    }
    let has_home: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('canon_session_epics') WHERE name='is_home')", [], |r|r.get(0))?;
    if !has_home {
        connection.execute_batch("ALTER TABLE canon_session_epics ADD COLUMN is_home INTEGER NOT NULL DEFAULT 0 CHECK(is_home IN (0,1));
            UPDATE canon_session_epics SET is_home=1")?;
    }
    drop_cancellation_state(connection)?;
    connection.execute_batch(include_str!("work_schema/indexes.sql"))
}

fn check_canon(db: &Connection) -> rusqlite::Result<()> {
    for table in [
        "canon_plans",
        "canon_epics",
        "canon_spec_nodes",
        "canon_spec_bodies",
        "canon_spec_revisions",
        "canon_spec_criteria",
        "canon_audit",
        "canon_events",
        "canon_counters",
        "canon_intents",
        "canon_cursors",
        "canon_session_epics",
        "canon_session_queue",
        "canon_session_queue_heads",
        "canon_session_queue_chains",
        "canon_epic_work_links",
    ] {
        if db
            .prepare(&format!("PRAGMA foreign_key_check('{table}')"))?
            .query([])?
            .next()?
            .is_some()
        {
            return Err(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT_FOREIGNKEY),
                Some("canon migration violates foreign keys".into()),
            ));
        }
    }
    Ok(())
}

fn drop_cancellation_state(connection: &Connection) -> rusqlite::Result<()> {
    let has_state: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('canon_step_cancellations') WHERE name='state')",
        [],
        |r| r.get(0),
    )?;
    if has_state {
        connection.execute_batch(
            "DROP INDEX IF EXISTS canon_cancellations_pending;
            ALTER TABLE canon_step_cancellations DROP COLUMN state",
        )?;
    }
    Ok(())
}
