use super::*;
#[tokio::test]
async fn proposal_queries_are_keyed_and_pin_the_partial_indexes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("CP-query-plans")?.start().await?;
    s.agent.terminate().await?;
    let path = s.sandbox.data.join("agent-runtime/btcc.sqlite");
    tokio::task::spawn_blocking(move || -> Result<(), HarnessError> {
        let db = butler_platform::sqlite::open(path)?;
        use butler_canon::store::proposals::queries::*;
        for (sql, index) in [
            (
                butler_canon::store::page::UNSCOPED_EPICS_PAGE,
                "canon_epics_page",
            ),
            (GET, "sqlite_autoindex_canon_proposals_1"),
            (OPEN_SESSION, "canon_proposals_open_session"),
            (OPEN_PAGE, "canon_proposals_chat_open"),
            (OPEN_BEFORE, "canon_proposals_chat_open"),
            (TURN, "canon_proposals_turn"),
            (COUNT, "canon_proposals_open_session"),
            (PROJECT_SPECS, "canon_spec_nodes_shared_project"),
        ] {
            let mut stmt = db.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
            let params = vec![rusqlite::types::Value::Null; stmt.parameter_count()];
            let plan = stmt
                .query_map(rusqlite::params_from_iter(params), |r| {
                    r.get::<_, String>(3)
                })?
                .collect::<Result<Vec<_>, _>>()?
                .join("\n");
            assert!(plan.contains(index), "{sql}: {plan}");
            for line in plan.lines().filter(|line| line.starts_with("SCAN ")) {
                assert!(
                    line.contains("USING INDEX") || line.contains("USING COVERING INDEX"),
                    "{sql}: {plan}"
                );
            }
            if sql == butler_canon::store::page::UNSCOPED_EPICS_PAGE {
                assert!(!plan.contains("TEMP B-TREE"), "{sql}: {plan}");
            }
            eprintln!("CP-PLAN {plan}");
        }
        Ok(())
    })
    .await
    .map_err(|e| HarnessError(e.to_string()))??;
    s.finish().await
}
