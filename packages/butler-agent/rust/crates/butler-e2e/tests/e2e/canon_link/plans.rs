use super::*;

#[tokio::test]
async fn every_canon_runtime_statement_is_indexed_and_idle_writes_nothing()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("CANON-LINK-PLANS")?.start().await?;
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    for query in butler_canon::store::runtime::queries::Query::all() {
        let mut stmt = db.prepare(&format!("EXPLAIN QUERY PLAN {}", query.sql()))?;
        let parameters = vec![rusqlite::types::Value::Null; stmt.parameter_count()];
        let plan = stmt
            .query_map(rusqlite::params_from_iter(parameters), |r| {
                r.get::<_, String>(3)
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        eprintln!("CANON-PLAN {query:?} {plan:?}");
        if matches!(query, butler_canon::store::runtime::queries::Query::Plans) {
            assert!(query.sql().ends_with("ORDER BY c.rowid LIMIT 256"));
            assert!(
                plan.iter()
                    .any(|line| line == "SEARCH c USING INTEGER PRIMARY KEY (rowid>?)"),
                "{plan:?}"
            );
        }
        assert!(
            plan.iter()
                .all(|line| !line.starts_with("SCAN ") || line == "SCAN CONSTANT ROW"),
            "{query:?}: {plan:?}"
        );
    }
    drop(db);
    s.agent.terminate().await?;
    crate::terminal_history::seed(&s.sandbox.data)?;
    crate::terminal_history::assert_indexed(&s.sandbox.data)?;
    s.gw = s.agent.start_again().await?;
    crate::terminal_history::assert_indexed(&s.sandbox.data)?;
    // No feed entries arrive in this idle isolated installation.
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let before: i64 = db.query_row("PRAGMA data_version", [], |r| r.get(0))?;
    tokio::time::sleep(Duration::from_millis(250)).await;
    let after: i64 = db.query_row("PRAGMA data_version", [], |r| r.get(0))?;
    assert_eq!(before, after, "idle canon publisher must not write");
    drop(db);
    s.finish().await
}
