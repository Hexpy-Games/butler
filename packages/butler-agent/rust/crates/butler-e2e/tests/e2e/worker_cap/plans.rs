//! Query-plan pins for the production derived-count and continuation FIFO SQL.
use super::*;
pub(super) fn assert_indexed(s: &Scenario) -> Result<(), HarnessError> {
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    for sql in [
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
        assert!(
            plan.iter().all(|line| !line.contains("SCAN ")),
            "{sql}: {plan:?}"
        );
    }
    Ok(())
}
