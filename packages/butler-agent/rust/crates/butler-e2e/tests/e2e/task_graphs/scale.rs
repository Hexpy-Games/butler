//! Owner-scale history with real indexed BTCC rows, never owner data.
use super::*;
use rusqlite::Connection;
use std::path::Path;

pub(super) async fn seed(data: &Path) -> Result<u64, HarnessError> {
    let mut builder = butler_e2e::e2e::task_graph::GraphBuilder::open(data)
        .await
        .map_err(fixture::error)?;
    builder
        .history(100_000, 10_000)
        .await
        .map_err(fixture::error)?;
    builder.close().await.map_err(fixture::error)?;
    let path = data.join("agent-runtime/btcc.sqlite");
    Connection::open(&path)?.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
    let bytes = std::fs::metadata(path)?.len();
    assert!(bytes >= 2_600_000_000, "fixture too small: {bytes}");
    Ok(bytes)
}
pub(super) fn assert_indexes(data: &Path) -> Result<(), HarnessError> {
    let db = Connection::open(data.join("agent-runtime/btcc.sqlite"))?;
    for (query, index) in [
        (
            "SELECT * FROM btcc_subsession_delegations WHERE json_extract(packet_json,'$.parent_work_ref.work_id')='work'",
            "idx_btcc_graph_work",
        ),
        (
            "SELECT * FROM btcc_session_relations WHERE parent_session_id='parent' AND parent_turn_id='turn' ORDER BY ordinal",
            "idx_btcc_graph_parent_turn",
        ),
        (
            "SELECT * FROM btcc_steward_results WHERE relation_id='relation' ORDER BY created_at DESC LIMIT 1",
            "idx_btcc_graph_result",
        ),
        (
            "SELECT * FROM agent_task_graph_changes WHERE seq>42 ORDER BY seq",
            "INTEGER PRIMARY KEY",
        ),
        (
            "SELECT * FROM btcc_guided_work_checkpoint_revisions WHERE work_id='source' AND plan_revision_id='plan' ORDER BY revision DESC LIMIT 1",
            "idx_btcc_graph_checkpoint_plan",
        ),
    ] {
        let plan = db
            .prepare(&format!("EXPLAIN QUERY PLAN {query}"))?
            .query_map([], |r| r.get::<_, String>(3))?
            .collect::<Result<Vec<_>, _>>()?
            .join("\n");
        assert!(plan.contains(index), "{query}: {plan}");
        assert!(
            !plan.contains("SCAN btcc_") && !plan.contains("SCAN agent_task_graph_changes"),
            "{plan}"
        );
    }
    let turns: i64 = db.query_row(
        "SELECT COUNT(*) FROM btcc_turns WHERE session_id='history'",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(turns, 100_000);
    let relations: i64 = db.query_row(
        "SELECT COUNT(*) FROM btcc_session_relations WHERE parent_session_id=(SELECT child_session_id FROM btcc_session_relations WHERE parent_session_id='butler/history' LIMIT 1)",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(relations, 10_000);
    Ok(())
}
