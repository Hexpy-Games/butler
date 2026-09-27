use rusqlite::Connection;

use super::{column_exists, ensure_column, table_definition, table_schema};
use crate::btcc::storage::schema::subsession::SUBSESSION_SCHEMA;

pub(super) fn migrate(db: &Connection) -> rusqlite::Result<()> {
    ensure_dispatch_intent(db)?;
    let Some(definition) = table_definition(db, "btcc_steward_results")? else {
        return Ok(());
    };
    if definition.contains("status IN ('success', 'blocked', 'failed', 'cancelled')")
        && definition.contains("'delegation_context_incomplete'")
        && definition.contains("'worker_work_incomplete'")
        && definition.contains("'worker_no_progress'")
        && !definition.contains("'task_needs_split'")
    {
        add_result_columns(db)?;
        return migrate_followup_results(db);
    }

    let code = source(db, "code", "NULL")?;
    let changed_files = source(db, "changed_files_json", "'[]'")?;
    let commits = source(db, "commits_json", "'[]'")?;
    let tests = source(db, "tests_json", "'[]'")?;
    let risks = source(db, "remaining_risks_json", "'[]'")?;
    let recommendations = source(db, "follow_up_recommendations_json", "'[]'")?;
    let refs = source(db, "detail_refs_json", "'[]'")?;
    let code = if definition.contains("'task_needs_split'") {
        "NULL"
    } else {
        code
    };
    db.execute_batch(
        "ALTER TABLE btcc_steward_results RENAME TO btcc_steward_results_ss02_success",
    )?;
    db.execute_batch(table_schema(SUBSESSION_SCHEMA, "btcc_steward_results")?)?;
    db.execute_batch(&format!(
        "INSERT INTO btcc_steward_results (result_id, relation_id, task_id, child_session_id, \
         child_turn_id, status, code, summary, acceptance_evidence_json, changed_artifacts_json, \
         changed_files_json, commits_json, tests_json, remaining_risks_json, \
         follow_up_recommendations_json, detail_refs_json, created_at) SELECT result_id, \
         relation_id, task_id, child_session_id, child_turn_id, status, {code}, summary, \
         acceptance_evidence_json, changed_artifacts_json, {changed_files}, {commits}, {tests}, \
         {risks}, {recommendations}, {refs}, created_at FROM btcc_steward_results_ss02_success; \
         DROP TABLE btcc_steward_results_ss02_success"
    ))?;
    add_result_columns(db)?;
    migrate_followup_results(db)
}

fn ensure_dispatch_intent(db: &Connection) -> rusqlite::Result<()> {
    if table_definition(db, "btcc_subsession_delegations")?.is_none() {
        return Ok(());
    }
    ensure_column(
        db,
        "btcc_subsession_delegations",
        "dispatch_intent_json",
        "TEXT",
    )?;
    ensure_column(
        db,
        "btcc_subsession_delegations",
        "dispatch_state",
        "TEXT CHECK (dispatch_state IS NULL OR dispatch_state IN ('pending', 'enqueued'))",
    )
}

fn add_result_columns(db: &Connection) -> rusqlite::Result<()> {
    for (name, declaration) in [
        ("commits_json", "TEXT NOT NULL DEFAULT '[]'"),
        ("tests_json", "TEXT NOT NULL DEFAULT '[]'"),
        ("remaining_risks_json", "TEXT NOT NULL DEFAULT '[]'"),
        (
            "follow_up_recommendations_json",
            "TEXT NOT NULL DEFAULT '[]'",
        ),
        ("detail_refs_json", "TEXT NOT NULL DEFAULT '[]'"),
        ("changed_files_json", "TEXT NOT NULL DEFAULT '[]'"),
        ("direction_revision", "INTEGER NOT NULL DEFAULT 0"),
    ] {
        ensure_column(db, "btcc_steward_results", name, declaration)?;
    }
    Ok(())
}

fn migrate_followup_results(db: &Connection) -> rusqlite::Result<()> {
    for table in ["btcc_steward_results", "btcc_subsession_outbox"] {
        let Some(definition) = table_definition(db, table)? else {
            continue;
        };
        if !definition.contains("relation_id TEXT NOT NULL UNIQUE") {
            continue;
        }
        let columns = table_columns(db, table)?.join(", ");
        let previous = format!("{table}_before_followup");
        db.execute_batch(&format!("ALTER TABLE {table} RENAME TO {previous}"))?;
        db.execute_batch(table_schema(SUBSESSION_SCHEMA, table)?)?;
        db.execute_batch(&format!(
            "INSERT INTO {table} ({columns}) SELECT {columns} FROM {previous} ORDER BY rowid; \
             DROP TABLE {previous}"
        ))?;
    }
    db.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_steward_results_relation \
         ON btcc_steward_results(relation_id)",
    )
}

fn source(
    db: &Connection,
    column: &'static str,
    fallback: &'static str,
) -> rusqlite::Result<&'static str> {
    Ok(if column_exists(db, "btcc_steward_results", column)? {
        column
    } else {
        fallback
    })
}

fn table_columns(db: &Connection, table: &str) -> rusqlite::Result<Vec<String>> {
    let mut statement = db.prepare(&format!("PRAGMA table_info({table})"))?;
    statement
        .query_map([], |row| row.get(1))?
        .collect::<rusqlite::Result<Vec<_>>>()
}
