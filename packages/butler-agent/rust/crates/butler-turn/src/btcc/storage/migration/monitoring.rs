//! Additive monitor indexes; deployed tables and their format remain intact.
use rusqlite::Connection;

const BACKFILL: &str =
    "activity_worker_id != activity_role||'-'||relation_id OR activity_worker_id IS NULL";

pub(super) fn indexes(db: &Connection) -> rusqlite::Result<()> {
    activity_indexes(db)?;
    db.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_btcc_work_monitor ON btcc_guided_works(         CASE WHEN status IN ('open', 'blocked') THEN 0 ELSE 1 END, updated_at DESC) \
         WHERE status != 'abandoned'; \
         CREATE INDEX IF NOT EXISTS idx_btcc_work_latest_binding \
         ON btcc_guided_turn_work_bindings(work_id, bound_at DESC);",
    )
}

fn activity_indexes(db: &Connection) -> rusqlite::Result<()> {
    for (column, declaration) in [
        ("activity_role", "TEXT"),
        ("activity_worker_id", "TEXT"),
        ("activity_terminal", "INTEGER NOT NULL DEFAULT 0"),
    ] {
        super::ensure_column(db, "btcc_session_relations", column, declaration)?;
    }
    let update = "UPDATE btcc_session_relations SET activity_role=(SELECT \
        CASE WHEN json_valid(d.packet_json) THEN COALESCE(json_extract(d.packet_json,'$.child_role'), \
        CASE WHEN child_session_id GLOB 'worker-*' THEN 'worker' ELSE 'steward' END) END \
        FROM btcc_subsession_delegations d WHERE d.relation_id=btcc_session_relations.relation_id), \
        activity_terminal=EXISTS(SELECT 1 FROM btcc_steward_results x WHERE x.relation_id=btcc_session_relations.relation_id)";
    let identity =
        "UPDATE btcc_session_relations SET activity_worker_id=activity_role||'-'||relation_id";
    if needs_backfill(db)? {
        db.execute_batch(&format!(
            "{update} WHERE activity_worker_id IS NULL; {identity} WHERE {BACKFILL};"
        ))?;
    }
    // Build after the first repair: an adopted DB leaves a sparse candidate set.
    db.execute_batch(&format!(
        "CREATE INDEX IF NOT EXISTS idx_btcc_activity_backfill
         ON btcc_session_relations(relation_id) WHERE {BACKFILL};"
    ))?;
    for table in ["btcc_subsession_delegations", "btcc_steward_results"] {
        for (op, rows) in [
            ("INSERT", vec!["NEW"]),
            ("UPDATE", vec!["OLD", "NEW"]),
            ("DELETE", vec!["OLD"]),
        ] {
            let mut body = String::new();
            for row in rows {
                for statement in [update, identity] {
                    body.push_str(statement);
                    body.push_str(" WHERE relation_id=");
                    body.push_str(row);
                    body.push_str(".relation_id; ");
                }
            }

            db.execute_batch(&format!("DROP TRIGGER IF EXISTS activity_{table}_{op}; CREATE TRIGGER activity_{table}_{op} AFTER {op} ON {table} BEGIN {body} END;"))?;
        }
    }
    db.execute_batch("CREATE INDEX IF NOT EXISTS idx_btcc_activity_page \
       ON btcc_session_relations(created_at DESC,activity_worker_id,relation_id); \
       CREATE INDEX IF NOT EXISTS idx_btcc_activity_identity ON btcc_session_relations(activity_worker_id); \
       CREATE INDEX IF NOT EXISTS idx_btcc_activity_open_page \
       ON btcc_session_relations(created_at DESC,activity_worker_id,relation_id) WHERE activity_terminal=0; \
       CREATE INDEX IF NOT EXISTS idx_btcc_activity_parent_page \
       ON btcc_session_relations(parent_session_id,created_at DESC,activity_worker_id,relation_id); \
       CREATE INDEX IF NOT EXISTS idx_btcc_activity_parent_open_page \
       ON btcc_session_relations(parent_session_id,created_at DESC,activity_worker_id,relation_id) WHERE activity_terminal=0;")
}

fn needs_backfill(db: &Connection) -> rusqlite::Result<bool> {
    let indexed: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='idx_btcc_activity_backfill')",
        [],
        |row| row.get(0),
    )?;
    if !indexed {
        return Ok(true);
    }
    db.query_row(
        &format!("SELECT EXISTS(SELECT 1 FROM btcc_session_relations WHERE {BACKFILL})"),
        [],
        |row| row.get(0),
    )
}
