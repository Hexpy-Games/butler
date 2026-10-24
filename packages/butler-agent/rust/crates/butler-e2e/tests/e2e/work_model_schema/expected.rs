use super::*;

pub(super) fn snapshot(db: &Connection, mut fresh: Snapshot) -> rusqlite::Result<Snapshot> {
    for (table, query) in [
        (
            "canon_plans",
            "SELECT id,project_id,title,description,due_on,status,revision,created_at,updated_at,created_by FROM wm_plans WHERE visibility='canon' ORDER BY id",
        ),
        (
            "canon_epics",
            "SELECT id,scope_ref,plan_id,spec_node_id,title,description,kind,canon_status,canon_status_source,assignee,plan_rank,origin,revision,created_at,updated_at,created_by FROM wm_works WHERE visibility='canon' ORDER BY id",
        ),
        (
            "canon_spec_nodes",
            "SELECT node_id,scope_kind,scope_ref,CASE WHEN work_id='wk_minutes' THEN NULL ELSE work_id END,parent_node_id,concern_id,visibility,active_revision,lifecycle,source,revision,created_at,updated_at,created_by FROM wm_spec_nodes WHERE visibility='canon' ORDER BY node_id",
        ),
        (
            "canon_spec_bodies",
            "SELECT * FROM wm_spec_bodies WHERE hash!='private-body' ORDER BY hash",
        ),
        (
            "canon_spec_revisions",
            "SELECT node_id,revision,body_hash,parser_version,state FROM wm_spec_revisions WHERE node_id!='sp_private' ORDER BY node_id,revision",
        ),
        (
            "canon_spec_criteria",
            "SELECT * FROM wm_spec_criteria ORDER BY node_id,revision",
        ),
        (
            "canon_session_epics",
            "SELECT home_session_id,id,created_at,created_by,'user' FROM wm_works WHERE visibility='canon' AND home_session_id IS NOT NULL ORDER BY home_session_id,id",
        ),
        ("canon_audit", "SELECT * FROM wm_audit ORDER BY seq"),
        (
            "canon_events",
            "SELECT seq,topic,payload_json,1,created_at FROM wm_outbox WHERE seq=1",
        ),
        ("canon_counters", "SELECT * FROM wm_counts ORDER BY 1,2"),
        (
            "canon_intents",
            "SELECT * FROM wm_cross_db_intents WHERE state='pending' ORDER BY op_id",
        ),
    ] {
        fresh.insert(table.into(), rows(db, query)?);
    }
    Ok(fresh)
}
