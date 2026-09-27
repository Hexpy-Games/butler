mod authority;
mod subsession;

use rusqlite::{Connection, TransactionBehavior, params};

use super::schema::{effects, work};

pub(super) fn apply(connection: &mut Connection) -> rusqlite::Result<()> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    authority::migrate(&transaction)?;
    subsession::migrate(&transaction)?;
    ensure_legacy_work_import_provenance(&transaction)?;
    ensure_guided_tool_journal_order(&transaction)?;
    ensure_guided_work_result_order(&transaction)?;
    ensure_project_work_projection_columns(&transaction)?;
    ensure_guided_work_disposition_schema(&transaction)?;
    transaction.execute_batch(effects::EFFECTS_SCHEMA)?;
    ensure_restart_handoff_columns(&transaction)?;
    ensure_guided_work_progress_columns(&transaction)?;
    migrate_guided_work_execution_ownership(&transaction)?;
    ensure_turn_columns(&transaction)?;
    ensure_model_columns(&transaction)?;
    ensure_guided_tool_result_delivery_columns(&transaction)?;
    migrate_guided_work_checkpoint_constraints(&transaction)?;
    migrate_guided_work_review_constraints(&transaction)?;
    restore_stable_work_objectives(&transaction)?;
    transaction.commit()
}

fn ensure_restart_handoff_columns(db: &Connection) -> rusqlite::Result<()> {
    ensure_column(db, "btcc_guided_effects", "handoff_state", "TEXT")?;
    ensure_column(db, "btcc_guided_effects", "handoff_error", "TEXT")
}

fn ensure_turn_columns(db: &Connection) -> rusqlite::Result<()> {
    if !table_exists(db, "btcc_turns")? {
        return Ok(());
    }
    for (name, declaration) in [
        ("progress_destination_json", "TEXT"),
        ("route_state_json", "TEXT"),
        ("continuation_budget_json", "TEXT"),
        ("suspension_reason", "TEXT"),
        ("authority_continuation_json", "TEXT"),
    ] {
        ensure_column(db, "btcc_turns", name, declaration)?;
    }
    if table_exists(db, "btcc_authority_requests")? {
        ensure_column(db, "btcc_authority_requests", "source_call_id", "TEXT")?;
        ensure_column(
            db,
            "btcc_authority_requests",
            "allow_scope",
            "TEXT NOT NULL DEFAULT 'once'",
        )?;
    }
    Ok(())
}

fn ensure_model_columns(db: &Connection) -> rusqlite::Result<()> {
    if table_exists(db, "btcc_model_round_acceptances")? {
        ensure_column(
            db,
            "btcc_model_round_acceptances",
            "checkpoint_id",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column(
            db,
            "btcc_model_round_acceptances",
            "checkpoint_revision",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
    }
    if table_exists(db, "btcc_model_route_events")? {
        ensure_column(db, "btcc_model_route_events", "failure_disposition", "TEXT")?;
    }
    Ok(())
}

fn ensure_project_work_projection_columns(db: &Connection) -> rusqlite::Result<()> {
    if table_exists(db, "btcc_guided_works")? {
        ensure_column(db, "btcc_guided_works", "ledger_project_id", "TEXT")?;
        ensure_column(db, "btcc_guided_works", "canonical_head_sha256", "TEXT")?;
    }
    Ok(())
}

fn ensure_guided_work_disposition_schema(db: &Connection) -> rusqlite::Result<()> {
    if !table_exists(db, "btcc_guided_works")? {
        return Ok(());
    }
    db.execute_batch(work::WORK_SCHEMA)?;
    if table_exists(db, "btcc_guided_work_disposition_revisions")? {
        for (name, declaration) in [
            ("result_sequence", "INTEGER NOT NULL DEFAULT 0"),
            ("material_fingerprint", "TEXT NOT NULL DEFAULT ''"),
            ("runtime_owned_open", "INTEGER NOT NULL DEFAULT 0"),
        ] {
            ensure_column(
                db,
                "btcc_guided_work_disposition_revisions",
                name,
                declaration,
            )?;
        }
    }
    Ok(())
}

fn ensure_guided_tool_result_delivery_columns(db: &Connection) -> rusqlite::Result<()> {
    if !table_exists(db, "btcc_guided_tool_calls")? {
        return Ok(());
    }
    for (name, declaration) in [
        ("delivery_state", "TEXT"),
        ("delivery_round_id", "TEXT"),
        ("delivery_response_sha256", "TEXT"),
        ("changed_files_json", "TEXT"),
    ] {
        ensure_column(db, "btcc_guided_tool_calls", name, declaration)?;
    }
    Ok(())
}

fn ensure_guided_work_result_order(db: &Connection) -> rusqlite::Result<()> {
    let table = "btcc_guided_work_results";
    if !table_exists(db, table)? {
        return Ok(());
    }
    ensure_column(db, table, "source_turn_rowid", "INTEGER")?;
    ensure_column(db, table, "source_turn_sequence", "INTEGER")?;
    if table_exists(db, "btcc_turns")? {
        db.execute_batch(
            "UPDATE btcc_guided_work_results SET source_turn_rowid = \
             (SELECT turns.rowid FROM btcc_turns turns WHERE turns.turn_id = \
             btcc_guided_work_results.origin_turn_id) WHERE source_turn_rowid IS NULL",
        )?;
    }
    if table_exists(db, "btcc_guided_tool_calls")? {
        db.execute_batch(
            "UPDATE btcc_guided_work_results SET source_turn_sequence = \
             (SELECT calls.turn_sequence FROM btcc_guided_tool_calls calls WHERE calls.call_id = \
             btcc_guided_work_results.tool_call_id) WHERE source_turn_sequence IS NULL",
        )?;
    }
    db.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_btcc_guided_work_results_source_order \
         ON btcc_guided_work_results(work_id, source_turn_rowid, source_turn_sequence, sequence)",
    )
}

fn ensure_guided_tool_journal_order(db: &Connection) -> rusqlite::Result<()> {
    let table = "btcc_guided_tool_calls";
    if !table_exists(db, table)? {
        return Ok(());
    }
    ensure_column(db, table, "turn_sequence", "INTEGER")?;
    let mut statement = db.prepare(
        "SELECT rowid, turn_id, turn_sequence FROM btcc_guided_tool_calls \
         ORDER BY turn_id, rowid",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<i64>>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    let mut current_turn = String::new();
    let mut next = 0_i64;
    for (rowid, turn_id, sequence) in rows {
        if turn_id != current_turn {
            current_turn = turn_id;
            next = 0;
        }
        if let Some(sequence) = sequence {
            next = next.max(sequence);
        } else {
            next += 1;
            db.execute(
                "UPDATE btcc_guided_tool_calls SET turn_sequence = ?1 WHERE rowid = ?2",
                params![next, rowid],
            )?;
        }
    }
    db.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_btcc_guided_tool_calls_turn_sequence \
         ON btcc_guided_tool_calls(turn_id, turn_sequence)",
    )
}

fn ensure_legacy_work_import_provenance(db: &Connection) -> rusqlite::Result<()> {
    if table_exists(db, "btcc_guided_work_legacy_imports")? {
        ensure_column(
            db,
            "btcc_guided_work_legacy_imports",
            "source_authority",
            "TEXT NOT NULL DEFAULT 'session_sqlite'",
        )?;
        ensure_column(
            db,
            "btcc_guided_work_legacy_imports",
            "source_revision",
            "TEXT NOT NULL DEFAULT 'unknown'",
        )?;
    }
    Ok(())
}

fn ensure_guided_work_progress_columns(db: &Connection) -> rusqlite::Result<()> {
    if table_exists(db, "btcc_guided_work_plan_revisions")? {
        ensure_column(
            db,
            "btcc_guided_work_plan_revisions",
            "governing_refs_json",
            "TEXT NOT NULL DEFAULT '[]'",
        )?;
        ensure_column(
            db,
            "btcc_guided_work_plan_revisions",
            "execution_mode",
            "TEXT CHECK (execution_mode IN ('direct', 'steward', 'workers'))",
        )?;
    }
    if table_exists(db, "btcc_guided_work_checkpoint_revisions")? {
        ensure_column(
            db,
            "btcc_guided_work_checkpoint_revisions",
            "plan_revision_id",
            "TEXT",
        )?;
        ensure_column(
            db,
            "btcc_guided_work_checkpoint_revisions",
            "action_states_json",
            "TEXT NOT NULL DEFAULT '[]'",
        )?;
    }
    Ok(())
}

fn migrate_guided_work_execution_ownership(db: &Connection) -> rusqlite::Result<()> {
    let table = "btcc_guided_work_plan_revisions";
    let Some(definition) = table_definition(db, table)? else {
        return Ok(());
    };
    if definition.contains("'steward'") {
        return Ok(());
    }
    db.execute_batch(
        "ALTER TABLE btcc_guided_work_plan_revisions RENAME TO \
         btcc_guided_work_plan_revisions_before_steward_ownership",
    )?;
    db.execute_batch(table_schema(work::WORK_SCHEMA, table)?)?;
    let columns = "plan_revision_id, work_id, revision, objective, governing_refs_json, \
                   execution_mode, actions_json, checks_json, origin_turn_id, created_at";
    db.execute_batch(&format!(
        "INSERT INTO {table} ({columns}) SELECT {columns} FROM \
         btcc_guided_work_plan_revisions_before_steward_ownership; \
         DROP TABLE btcc_guided_work_plan_revisions_before_steward_ownership"
    ))
}

fn migrate_guided_work_checkpoint_constraints(db: &Connection) -> rusqlite::Result<()> {
    let table = "btcc_guided_work_checkpoint_revisions";
    let Some(definition) = table_definition(db, table)? else {
        return Ok(());
    };
    if definition.contains("'validation'") {
        return Ok(());
    }
    db.execute_batch(
        "ALTER TABLE btcc_guided_work_checkpoint_revisions RENAME TO \
         btcc_guided_work_checkpoint_revisions_r3_11",
    )?;
    let schema = table_schema(work::WORK_SCHEMA, table)?.replace(
        "  plan_revision_id TEXT NOT NULL,",
        "  plan_revision_id TEXT,",
    );
    db.execute_batch(&schema)?;
    db.execute_batch(
        "INSERT INTO btcc_guided_work_checkpoint_revisions \
         (checkpoint_revision_id, work_id, revision, plan_revision_id, stage, public_summary, \
          next_step, action_states_json, result_sequence, origin_turn_id, created_at) \
         SELECT checkpoint_revision_id, work_id, revision, plan_revision_id, stage, public_summary, \
          next_step, action_states_json, result_sequence, origin_turn_id, created_at \
         FROM btcc_guided_work_checkpoint_revisions_r3_11 ORDER BY work_id, revision; \
         DROP TABLE btcc_guided_work_checkpoint_revisions_r3_11",
    )
}

fn migrate_guided_work_review_constraints(db: &Connection) -> rusqlite::Result<()> {
    let table = "btcc_guided_work_review_revisions";
    let Some(definition) = table_definition(db, table)? else {
        return Ok(());
    };
    let has_result = column_exists(db, table, "bound_result_review_revision_id")?;
    let has_actions = column_exists(db, table, "bound_action_states_json")?;
    if definition.contains("'completion'") && has_result && has_actions {
        return Ok(());
    }
    db.execute_batch(
        "ALTER TABLE btcc_guided_work_review_revisions RENAME TO \
         btcc_guided_work_review_revisions_r3_11",
    )?;
    db.execute_batch(table_schema(work::WORK_SCHEMA, table)?)?;
    db.execute_batch(&format!(
        "INSERT INTO {table} (review_revision_id, work_id, revision, subject, verdict, summary, \
         corrections_json, bound_plan_revision_id, bound_result_sequence, \
         bound_result_review_revision_id, bound_action_states_json, origin_turn_id, created_at) \
         SELECT review_revision_id, work_id, revision, subject, verdict, summary, corrections_json, \
         bound_plan_revision_id, bound_result_sequence, {}, {}, origin_turn_id, created_at \
         FROM btcc_guided_work_review_revisions_r3_11 ORDER BY work_id, revision; \
         DROP TABLE btcc_guided_work_review_revisions_r3_11",
        if has_result { "bound_result_review_revision_id" } else { "NULL" },
        if has_actions { "bound_action_states_json" } else { "NULL" },
    ))
}

fn restore_stable_work_objectives(db: &Connection) -> rusqlite::Result<()> {
    if !table_exists(db, "btcc_guided_works")?
        || !table_exists(db, "btcc_guided_work_plan_revisions")?
    {
        return Ok(());
    }
    db.execute_batch(
        "UPDATE btcc_guided_works SET objective = (SELECT plan.objective FROM \
         btcc_guided_work_plan_revisions plan WHERE plan.work_id = btcc_guided_works.work_id \
         ORDER BY plan.revision ASC LIMIT 1) WHERE EXISTS (SELECT 1 FROM \
         btcc_guided_work_plan_revisions plan WHERE plan.work_id = btcc_guided_works.work_id)",
    )
}

pub(super) fn ensure_column(
    db: &Connection,
    table: &str,
    column: &str,
    declaration: &str,
) -> rusqlite::Result<()> {
    if column_exists(db, table, column)? {
        return Ok(());
    }
    db.execute_batch(&format!(
        "ALTER TABLE {table} ADD COLUMN {column} {declaration}"
    ))
}

pub(super) fn column_exists(db: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    let mut statement = db.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(names.iter().any(|name| name == column))
}

pub(super) fn table_definition(db: &Connection, name: &str) -> rusqlite::Result<Option<String>> {
    db.query_row(
        "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?1",
        [name],
        |row| row.get(0),
    )
    .optional()
}

pub(super) fn table_exists(db: &Connection, name: &str) -> rusqlite::Result<bool> {
    Ok(table_definition(db, name)?.is_some())
}

pub(super) fn table_schema<'a>(schema: &'a str, table: &str) -> rusqlite::Result<&'a str> {
    let marker = format!("CREATE TABLE IF NOT EXISTS {table} (");
    let start = schema
        .find(&marker)
        .ok_or_else(|| rusqlite::Error::InvalidParameterName(format!("schema:{table}")))?;
    let tail = &schema[start..];
    let end = tail
        .find(";\n")
        .ok_or_else(|| rusqlite::Error::InvalidParameterName(format!("schema:{table}:end")))?;
    Ok(&tail[..=end])
}

use rusqlite::OptionalExtension;
