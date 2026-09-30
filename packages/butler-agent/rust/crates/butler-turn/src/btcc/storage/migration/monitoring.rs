//! Additive monitor indexes; deployed tables and their format remain intact.
use rusqlite::Connection;

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
    let identity = "UPDATE btcc_session_relations SET activity_worker_id=activity_role||'-'|| \
        CASE WHEN activity_terminal=1 AND length((SELECT task_id FROM btcc_subsession_delegations d WHERE d.relation_id=btcc_session_relations.relation_id))>0 THEN (SELECT task_id FROM btcc_subsession_delegations d \
        WHERE d.relation_id=btcc_session_relations.relation_id) ELSE relation_id END";
    db.execute_batch(&format!(
        "{update} WHERE activity_worker_id IS NULL; {identity} WHERE activity_worker_id IS NULL;"
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

            db.execute_batch(&format!("CREATE TRIGGER IF NOT EXISTS activity_{table}_{op} AFTER {op} ON {table} BEGIN {body} END;"))?;
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
