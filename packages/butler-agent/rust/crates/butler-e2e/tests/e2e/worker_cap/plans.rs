//! Query-plan pins for the production derived-count and continuation FIFO SQL.
use super::*;
pub(super) fn assert_indexed(s: &Scenario) -> Result<(), HarnessError> {
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    use butler_turn::btcc::storage::*;
    let enqueued = enqueued_workers_sql();
    for sql in [
        enqueued.as_str(),
        RESET_DIRECTION_DISPATCH_SQL,
        COMPLETE_WORKER_SQL,
        RESTORE_WAITING_DIRECTION_SQL,
        WORKER_TURN_UNSETTLED_SQL,
        butler_turn::btcc::storage::RUNNING_WORKERS_SQL,
        butler_turn::btcc::storage::WAITING_WORKERS_SQL,
        butler_turn::btcc::storage::WORKER_RESULT_MARKER_SQL,
        butler_turn::btcc::storage::RETRY_WORKER_SQL,
    ] {
        let mut statement = db.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
        let parameters = vec!["parent"; statement.parameter_count()];
        let plan = statement
            .query_map(rusqlite::params_from_iter(parameters), |r| {
                r.get::<_, String>(3)
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        eprintln!("WORKER-CAP-PLAN {plan:?}");
        if sql == RUNNING_WORKERS_SQL {
            assert!(
                plan.iter().any(|line| {
                    line.starts_with("SEARCH t USING COVERING INDEX idx_btcc_worker_live_turns ")
                }),
                "running count must search the live-turn index: {plan:?}"
            );
        }
        // EXISTS evaluates one constant row; only reads of tables can scan.
        assert!(
            plan.iter()
                .all(|line| !line.starts_with("SCAN ") || line == "SCAN CONSTANT ROW"),
            "{sql}: {plan:?}"
        );
    }
    Ok(())
}

#[tokio::test]
async fn cb_11_worker_index_upgrade_preserves_history_plans() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("CB-11-INDEX-UPGRADE")?.start().await?;
    assert_indexed(&s)?;
    s.agent.terminate().await?;
    crate::terminal_history::seed(&s.sandbox.data)?;
    let db = rusqlite::Connection::open(crate::terminal_history::path(&s.sandbox.data))?;
    db.execute_batch(
        "DROP INDEX idx_btcc_worker_live_turns;
         CREATE INDEX idx_btcc_worker_turns ON btcc_turns(session_id,semantic_state,turn_id);",
    )?;
    drop(db);
    // Upgrade the old broad index, then repeat startup with the replacement present.
    for _ in 0..2 {
        s.gw = s.agent.start_again().await?;
        assert_indexed(&s)?;
        crate::terminal_history::assert_indexed(&s.sandbox.data)?;
        crate::terminal_history::assert_complete(&s.sandbox.data)?;
        let db = rusqlite::Connection::open(crate::terminal_history::path(&s.sandbox.data))?;
        let old: u64 = db.query_row(
            "SELECT count(*) FROM sqlite_schema WHERE type='index' AND name='idx_btcc_worker_turns'",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(old, 0, "the broad covering index must be removed");
        s.agent.terminate().await?;
    }
    s.finish().await
}
