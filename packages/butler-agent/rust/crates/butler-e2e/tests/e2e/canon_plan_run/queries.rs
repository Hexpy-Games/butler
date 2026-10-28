use super::*;
#[tokio::test]
async fn queue_request_and_runtime_reads_use_indexes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, _, server, _, _) = crate::canon_link::setup("CB-QUEUE-INDEX", false, false).await?;
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    for query in butler_canon::store::queue::sql::READS {
        let mut statement = db.prepare(&format!("EXPLAIN QUERY PLAN {query}"))?;
        let parameters = vec![rusqlite::types::Value::Null; statement.parameter_count()];
        let plan = statement
            .query_map(rusqlite::params_from_iter(parameters), |r| {
                r.get::<_, String>(3)
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        assert!(
            plan.iter()
                .all(|l| !l.starts_with("SCAN ") || l == "SCAN CONSTANT ROW"),
            "{query}: {plan:?}"
        );
    }
    drop(db);
    s.finish().await?;
    server.abort();
    Ok(())
}
