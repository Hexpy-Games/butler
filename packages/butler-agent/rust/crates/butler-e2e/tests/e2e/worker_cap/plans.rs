//! Query-plan pins for admission, direction guard and slot release.
use super::*;
pub(super) fn assert_indexed(s: &Scenario) -> Result<(), HarnessError> {
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    for sql in [
        "SELECT EXISTS(SELECT 1 FROM btcc_subsession_delegations WHERE relation_id=?1 AND child_role='worker' AND dispatch_state='pending')",
        "SELECT relation_id FROM btcc_subsession_delegations WHERE parent_session_id=?1 AND child_role='worker' AND dispatch_state='pending' ORDER BY created_at,rowid LIMIT 1",
        "SELECT count(*) FROM btcc_subsession_delegations WHERE parent_session_id=?1 AND child_role='worker' AND dispatch_state='enqueued'",
        "SELECT EXISTS (SELECT 1 FROM btcc_steward_results x WHERE x.child_turn_id=d.child_turn_id AND x.relation_id=d.relation_id AND x.status<>'cancelled') FROM btcc_subsession_delegations d WHERE d.relation_id=?1 AND d.dispatch_state='enqueued'",
        "UPDATE btcc_subsession_delegations SET dispatch_state='enqueued' WHERE relation_id=?1",
        "UPDATE btcc_subsession_delegations SET dispatch_state=NULL,slot_release_result_id=NULL WHERE relation_id=(SELECT relation_id FROM btcc_steward_results WHERE result_id=?1) AND slot_release_result_id=?1 AND (EXISTS (SELECT 1 FROM btcc_steward_results x WHERE x.result_id=?1 AND x.status='cancelled') OR (NOT EXISTS (SELECT 1 FROM btcc_subsession_directions i WHERE i.relation_id=btcc_subsession_delegations.relation_id AND i.status='pending') AND NOT EXISTS (SELECT 1 FROM btcc_session_relations r JOIN btcc_turns t ON t.session_id=r.child_session_id WHERE r.relation_id=btcc_subsession_delegations.relation_id AND t.semantic_state='admitted' AND NOT EXISTS (SELECT 1 FROM btcc_steward_results x WHERE x.relation_id=r.relation_id AND x.child_turn_id=t.turn_id))))",
        "UPDATE btcc_subsession_delegations SET slot_release_result_id='result',dispatch_state=CASE WHEN dispatch_state='pending' THEN NULL ELSE dispatch_state END WHERE relation_id=?1 AND ('success'='cancelled' OR NOT EXISTS (SELECT 1 FROM btcc_subsession_directions WHERE relation_id=?1 AND status='pending'))",
        "UPDATE btcc_subsession_delegations SET dispatch_state='pending',slot_release_result_id=NULL WHERE relation_id=?1 AND child_role='worker' AND dispatch_state IS NULL AND EXISTS (SELECT 1 FROM btcc_subsession_directions WHERE relation_id=?1 AND status='pending')",
        "SELECT d.relation_id FROM btcc_subsession_delegations d WHERE d.dispatch_state='enqueued' AND d.child_role='worker' ORDER BY d.created_at,d.rowid",
    ] {
        let mut statement = db.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
        let parameters = vec!["parent"; statement.parameter_count()];
        let plan = statement
            .query_map(rusqlite::params_from_iter(parameters), |r| {
                r.get::<_, String>(3)
            })?
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
