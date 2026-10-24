//! Unreleased wm_* data is merged by identity; existing canon rows win.
use rusqlite::Connection;

fn exists(db: &Connection, table: &str) -> rusqlite::Result<bool> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?1)",
        [table],
        |r| r.get(0),
    )
}
pub(super) fn merged(db: &Connection) -> rusqlite::Result<()> {
    let present: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name GLOB 'wm_*')",
        [],
        |r| r.get(0),
    )?;
    if !present {
        return Ok(());
    }
    for (source, sql) in COPIES {
        if exists(db, source)? {
            db.execute_batch(sql)?;
        }
    }
    db.execute_batch(include_str!("drop_merged.sql"))
}
const COPIES: &[(&str, &str)] = &[
    (
        "wm_plans",
        "INSERT OR IGNORE INTO canon_plans SELECT id,project_id,title,description,due_on,status,revision,created_at,updated_at,created_by FROM wm_plans WHERE visibility='canon'",
    ),
    (
        "wm_works",
        "INSERT OR IGNORE INTO canon_epics SELECT id,scope_ref,plan_id,spec_node_id,title,description,kind,canon_status,canon_status_source,assignee,plan_rank,origin,revision,created_at,updated_at,created_by FROM wm_works WHERE visibility='canon'",
    ),
    (
        "wm_spec_bodies",
        "INSERT OR IGNORE INTO canon_spec_bodies SELECT * FROM wm_spec_bodies WHERE hash IN (SELECT r.body_hash FROM wm_spec_revisions r JOIN wm_spec_nodes n ON n.node_id=r.node_id WHERE n.visibility='canon')",
    ),
    (
        "wm_spec_nodes",
        "INSERT OR IGNORE INTO canon_spec_nodes SELECT node_id,scope_kind,scope_ref,CASE WHEN work_id IN (SELECT id FROM canon_epics) THEN work_id END,parent_node_id,concern_id,visibility,active_revision,lifecycle,source,revision,created_at,updated_at,created_by FROM wm_spec_nodes WHERE visibility='canon'",
    ),
    (
        "wm_spec_revisions",
        "INSERT OR IGNORE INTO canon_spec_revisions SELECT r.node_id,r.revision,r.body_hash,r.parser_version,r.state FROM wm_spec_revisions r JOIN wm_spec_nodes n ON n.node_id=r.node_id WHERE n.visibility='canon'",
    ),
    (
        "wm_spec_criteria",
        "INSERT OR IGNORE INTO canon_spec_criteria SELECT c.* FROM wm_spec_criteria c JOIN wm_spec_nodes n ON n.node_id=c.node_id WHERE n.visibility='canon'",
    ),
    (
        "wm_works",
        "INSERT OR IGNORE INTO canon_session_epics SELECT home_session_id,id,created_at,created_by,'user' FROM wm_works WHERE visibility='canon' AND home_session_id IS NOT NULL",
    ),
    (
        "wm_audit",
        "INSERT OR IGNORE INTO canon_audit SELECT * FROM wm_audit",
    ),
    (
        "wm_outbox",
        "INSERT OR IGNORE INTO canon_events SELECT * FROM wm_outbox WHERE published=0 AND topic='canon.changed'",
    ),
    (
        "wm_counts",
        "INSERT OR IGNORE INTO canon_counters SELECT * FROM wm_counts",
    ),
    (
        "wm_cross_db_intents",
        "INSERT OR IGNORE INTO canon_intents SELECT * FROM wm_cross_db_intents WHERE state='pending'",
    ),
];
