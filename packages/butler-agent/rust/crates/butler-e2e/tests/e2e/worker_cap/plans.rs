//! Query-plan pins for admission, direction guard and slot release.
use super::*;
pub(super) fn assert_indexed(s: &Scenario) -> Result<(), HarnessError> {
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    for sql in [
        "SELECT relation_id,created_at,activity_worker_id FROM btcc_session_relations WHERE activity_role IN ('worker','steward') AND activity_terminal=0 AND activity_owner_session_id=?1 ORDER BY created_at DESC,activity_worker_id,relation_id LIMIT 20",
        "SELECT relation_id FROM btcc_session_relations WHERE activity_worker_id=?1 AND (0 OR activity_terminal=0) AND ('parent' IS NULL OR activity_owner_session_id='parent')",
        "SELECT COALESCE(activity_owner_session_id,parent_session_id) FROM btcc_session_relations WHERE relation_id=?1",
        "SELECT activity_owner_session_id FROM btcc_session_relations WHERE child_session_id=?1",
        "SELECT EXISTS(SELECT 1 FROM btcc_subsession_delegations WHERE relation_id=?1 AND child_role='worker' AND dispatch_state='pending')",
        "SELECT relation_id FROM btcc_subsession_delegations WHERE parent_session_id=?1 AND child_role='worker' AND dispatch_state='pending' ORDER BY created_at,rowid LIMIT 1",
        "SELECT count(*) FROM btcc_subsession_delegations WHERE parent_session_id=?1 AND child_role='worker' AND dispatch_state='enqueued'",
        "SELECT EXISTS (SELECT 1 FROM btcc_steward_results x WHERE x.child_turn_id=d.child_turn_id AND x.relation_id=d.relation_id AND x.status<>'cancelled') FROM btcc_subsession_delegations d WHERE d.relation_id=?1 AND d.dispatch_state='enqueued'",
        "UPDATE btcc_subsession_delegations SET dispatch_state='enqueued' WHERE relation_id=?1",
        "UPDATE btcc_subsession_delegations SET dispatch_state=NULL WHERE relation_id=?1 AND ('success'='cancelled' OR NOT EXISTS (SELECT 1 FROM btcc_subsession_directions WHERE relation_id=?1 AND status='pending'))",
    ] {
        let plan = db
            .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?
            .query_map(["parent"], |r| r.get::<_, String>(3))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        eprintln!("WORKER-CAP-PLAN {plan:?}");
        assert!(
            plan.iter().all(
                |line| (!line.contains("SCAN ") || line == "SCAN CONSTANT ROW")
                    && !line.contains("TEMP B-TREE")
            ),
            "{sql}: {plan:?}"
        );
    }
    Ok(())
}
