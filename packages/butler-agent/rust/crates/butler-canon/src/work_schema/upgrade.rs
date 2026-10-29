//! Unreleased wm_* data is merged by identity; existing canon rows win.
use rusqlite::Connection;

fn exists(db: &Connection, table: &str) -> rusqlite::Result<bool> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?1)",
        [table],
        |r| r.get(0),
    )
}
pub(super) fn merged(db: &Connection) -> rusqlite::Result<bool> {
    let present: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name GLOB 'wm_*')",
        [],
        |r| r.get(0),
    )?;
    if !present {
        return Ok(false);
    }
    let mut copied = false;
    for (source, sql) in COPIES {
        if exists(db, source)? {
            db.execute_batch(sql)?;
            copied |= db.changes() > 0;
        }
    }
    if exists(db, "wm_works")? {
        db.execute_batch(
            "INSERT INTO canon_counters(scope_kind,scope_ref,key,count)
            SELECT 'project',project_id,'epics',COUNT(*) FROM canon_epics GROUP BY project_id
            ON CONFLICT(scope_kind,scope_ref,key) DO UPDATE SET count=excluded.count",
        )?;
    }
    for (table, scope, key, filter) in [
        ("canon_plans", "project_id", "plans", "1"),
        (
            "canon_spec_nodes",
            "scope_ref",
            "spec_nodes",
            "scope_kind='project'",
        ),
    ] {
        if exists(db, "wm_counts")? {
            db.execute_batch(&format!(
                "INSERT INTO canon_counters SELECT 'project',{scope},'{key}',COUNT(*)
                FROM {table} WHERE {filter} GROUP BY {scope}
                ON CONFLICT(scope_kind,scope_ref,key) DO UPDATE SET count=excluded.count"
            ))?;
        }
    }
    db.execute_batch(include_str!("drop_merged.sql"))?;
    Ok(copied)
}
// Copy dependent rows before entities so collision guards see the pre-upgrade state.
const COPIES: &[(&str, &str)] = &[
    (
        "wm_works",
        "INSERT INTO canon_session_epics(session_id,epic_id,bound_at,bound_by,origin,is_home) SELECT home_session_id,id,created_at,created_by,'user',1 FROM wm_works WHERE visibility='canon' AND home_session_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM canon_epics WHERE id=wm_works.id) ON CONFLICT(session_id,epic_id) DO NOTHING",
    ),
    (
        "wm_audit",
        "INSERT INTO canon_audit(entity_kind,entity_id,revision,actor_json,op,at,payload_json)
         SELECT entity_kind,entity_id,revision,actor_json,op,at,payload_json
         FROM wm_audit WHERE (entity_kind='work' AND NOT EXISTS(SELECT 1 FROM canon_epics WHERE id=wm_audit.entity_id) AND entity_id IN (SELECT id FROM wm_works WHERE visibility='canon'))
         OR (entity_kind='plan' AND NOT EXISTS(SELECT 1 FROM canon_plans WHERE id=wm_audit.entity_id) AND entity_id IN (SELECT id FROM wm_plans WHERE visibility='canon'))
         OR (entity_kind='spec_node' AND NOT EXISTS(SELECT 1 FROM canon_spec_nodes WHERE node_id=wm_audit.entity_id) AND entity_id IN (SELECT node_id FROM wm_spec_nodes WHERE visibility='canon'))
         OR (entity_kind='backlog' AND NOT EXISTS(SELECT 1 FROM canon_counters WHERE scope_kind='project' AND scope_ref=wm_audit.entity_id AND key='backlog_revision') AND entity_id IN (SELECT scope_ref FROM wm_counts WHERE scope_kind='project' AND key='backlog_revision'))
         OR (entity_kind='intent' AND NOT EXISTS(SELECT 1 FROM canon_intents WHERE op_id=wm_audit.entity_id) AND entity_id IN (SELECT op_id FROM wm_cross_db_intents WHERE state='pending' AND kind='canon_conversation' AND json_extract(payload_json,'$.work_id') IN (SELECT id FROM wm_works WHERE visibility='canon')))
         ORDER BY seq",
    ),
    (
        "wm_cross_db_intents",
        "INSERT INTO canon_intents SELECT * FROM wm_cross_db_intents WHERE state='pending' AND kind='canon_conversation' AND NOT EXISTS(SELECT 1 FROM canon_epics WHERE id=json_extract(payload_json,'$.work_id')) AND json_extract(payload_json,'$.work_id') IN (SELECT id FROM wm_works WHERE visibility='canon') ON CONFLICT(op_id) DO NOTHING",
    ),
    (
        "wm_plans",
        "INSERT INTO canon_plans SELECT id,project_id,title,description,due_on,status,revision,created_at,updated_at,created_by FROM wm_plans WHERE visibility='canon' ON CONFLICT(id) DO NOTHING",
    ),
    (
        "wm_works",
        "INSERT INTO canon_epics SELECT id,scope_ref,plan_id,spec_node_id,title,description,kind,canon_status,canon_status_source,assignee,plan_rank,origin,revision,created_at,updated_at,created_by FROM wm_works WHERE visibility='canon' ON CONFLICT(id) DO NOTHING",
    ),
    (
        "wm_spec_bodies",
        "INSERT INTO canon_spec_bodies SELECT * FROM wm_spec_bodies WHERE hash IN (SELECT r.body_hash FROM wm_spec_revisions r JOIN wm_spec_nodes n ON n.node_id=r.node_id WHERE n.visibility='canon') ON CONFLICT(hash) DO NOTHING",
    ),
    (
        "wm_spec_nodes",
        "INSERT INTO canon_spec_nodes SELECT node_id,scope_kind,scope_ref,CASE WHEN work_id IN (SELECT id FROM canon_epics) THEN work_id END,parent_node_id,concern_id,visibility,active_revision,lifecycle,source,revision,created_at,updated_at,created_by FROM wm_spec_nodes WHERE visibility='canon' ON CONFLICT(node_id) DO NOTHING",
    ),
    (
        "wm_spec_revisions",
        "INSERT INTO canon_spec_revisions SELECT r.node_id,r.revision,r.body_hash,r.parser_version,r.state FROM wm_spec_revisions r JOIN wm_spec_nodes n ON n.node_id=r.node_id WHERE n.visibility='canon' ON CONFLICT(node_id,revision) DO NOTHING",
    ),
    (
        "wm_spec_criteria",
        "INSERT INTO canon_spec_criteria SELECT c.* FROM wm_spec_criteria c JOIN wm_spec_nodes n ON n.node_id=c.node_id WHERE n.visibility='canon' ON CONFLICT(node_id,revision,criterion_id) DO NOTHING",
    ),
    (
        "wm_outbox",
        "INSERT INTO sqlite_sequence(name,seq) SELECT 'canon_events',0 WHERE NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='canon_events'); UPDATE sqlite_sequence SET seq=MAX(seq,COALESCE((SELECT MAX(seq) FROM wm_outbox),0)) WHERE name='canon_events'; INSERT INTO canon_events(topic,payload_json,published,created_at) SELECT topic,payload_json,published,created_at FROM wm_outbox WHERE published=0 AND topic='canon.changed' ORDER BY seq",
    ),
    (
        "wm_counts",
        "INSERT INTO canon_counters SELECT scope_kind,scope_ref,key,count FROM wm_counts WHERE scope_kind='project' AND key='backlog_revision' ON CONFLICT(scope_kind,scope_ref,key) DO NOTHING",
    ),
];
