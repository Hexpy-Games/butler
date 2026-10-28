use super::*;
#[tokio::test]
async fn queue_request_and_runtime_reads_use_indexes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, _, server, epic, chat) =
        crate::canon_link::setup("CB-QUEUE-INDEX", false, false).await?;
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
    s.agent.terminate().await?;
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    db.execute_batch("ALTER TABLE canon_step_cancellations ADD COLUMN state TEXT NOT NULL DEFAULT 'pending' CHECK(state='pending'); CREATE INDEX canon_cancellations_pending ON canon_step_cancellations(state);")?;
    let owner = butler_gateway::gateway::app_session_hint(&chat);
    db.execute("INSERT INTO canon_step_cancellations(op_id,epic_id,source_session_id) VALUES('unresolved',?1,?2)",rusqlite::params![epic,owner])?;
    butler_canon::work_schema::ensure(&db)?;
    let saved: (String, String, String) =
        db.query_row("SELECT * FROM canon_step_cancellations", [], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?;
    assert_eq!(saved, ("unresolved".into(), epic, owner));
    assert_eq!(
        db.query_row::<i64, _, _>(
            "SELECT count(*) FROM pragma_table_info('canon_step_cancellations') WHERE name='state'",
            [],
            |r| r.get(0)
        )?,
        0
    );
    assert_eq!(
        db.query_row::<i64, _, _>(
            "SELECT count(*) FROM sqlite_schema WHERE name='canon_cancellations_pending'",
            [],
            |r| r.get(0)
        )?,
        0
    );
    db.execute("DELETE FROM canon_step_cancellations", [])?;
    drop(db);
    s.gw = s.agent.start_again().await?;
    s.finish().await?;
    server.abort();
    Ok(())
}
