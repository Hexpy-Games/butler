use super::*;
#[tokio::test]
async fn batched_tree_count_uses_keyed_node_criteria_and_check_indexes() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let (mut s, _, _) = fixture("CC-batch-plan").await?;
    s.agent.terminate().await?;
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let query = store::criteria::counts_query(4);
    let mut stmt = db.prepare(&format!("EXPLAIN QUERY PLAN {query}"))?;
    assert_eq!(stmt.parameter_count(), 4);
    let plan = stmt
        .query_map(["epic-a", "epic-b", "epic-c", "epic-d"], |r| {
            r.get::<_, String>(3)
        })?
        .collect::<Result<Vec<_>, _>>()?
        .join("\n");
    for index in [
        "sqlite_autoindex_canon_epics_1",
        "canon_spec_nodes_epic_parent",
        "sqlite_autoindex_canon_spec_criteria_1",
        "sqlite_autoindex_canon_criterion_checks_1",
    ] {
        assert!(plan.contains(index), "{query}: {plan}");
    }
    // SCAN t walks only the recursive work table seeded by the requested epic IDs.
    for line in plan.lines().filter(|line| line.starts_with("SCAN ")) {
        assert!(
            line == "SCAN t"
                || line.contains("USING INDEX")
                || line.contains("USING COVERING INDEX"),
            "{query}: {plan}"
        );
    }
    assert!(!plan.contains("TEMP B-TREE"), "{plan}");
    eprintln!("CC-BATCH-PLAN {plan}");
    drop(stmt);
    drop(db);
    s.finish().await
}
