//! Parent ownership through real Work services, restart and public graph reads.
use super::*;
use butler_e2e::e2e::{
    scenario::Scenario,
    task_graph::{Error, GraphBuilder, GraphWork, actions},
};
use rusqlite::{Connection, params};
use serde_json::Value;

fn db(s: &Scenario) -> Result<Connection, Error> {
    Ok(Connection::open(
        s.sandbox.data.join("agent-runtime/btcc.sqlite"),
    )?)
}
async fn graph(s: &Scenario) -> Result<Value, Error> {
    let reply =
        s.gw.get("/sessions/general/task-graphs?include_nodes=true")
            .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    assert_eq!(reply.data()["total"], 1);
    let id = reply.data()["graphs"][0]["graph_id"].as_str().unwrap();
    let detail = s.gw.get(&format!("/plans/{id}/task-graph")).await?;
    assert_eq!(detail.status, 200, "{}", detail.text);
    Ok(detail.data().clone())
}
fn assert_closed(s: &Scenario, child: &GraphWork) -> Result<(), Error> {
    let db = db(s)?;
    let state: (String, String, String, i64) = db.query_row(
        "SELECT w.status,t.semantic_state,x.status,r.activity_terminal FROM btcc_guided_works w JOIN btcc_subsession_delegations d ON d.root_work_id=w.work_id JOIN btcc_session_relations r ON r.relation_id=d.relation_id JOIN btcc_turns t ON t.turn_id=d.child_turn_id JOIN btcc_steward_results x ON x.relation_id=r.relation_id WHERE w.work_id=?1",
        [&child.view.work_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
    assert_eq!(
        state,
        (
            "abandoned".into(),
            "cancelled".into(),
            "cancelled".into(),
            1
        )
    );
    Ok(())
}
fn assert_terminal(graph: &Value) {
    assert_eq!(graph["state"], "cancelled");
    assert_eq!(graph["counts"]["running"], 0);
    assert!(
        graph["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .all(|n| !matches!(n["status"].as_str(), Some("running" | "review")))
    );
}

#[tokio::test]
async fn task_graphs_abandon_parent_closes_nested_delegation() -> Result<(), Error> {
    butler_e2e::gate!();
    let s = Setup::new("GRAPH-PARENT-TERMINAL")?.start().await?;
    let mut b = GraphBuilder::open(&s.sandbox.data).await?;
    let (mut owner, mut child) = b
        .unplanned("butler/app-general", 1, "Release objective")
        .await?;
    b.plan(&mut child, "workers", actions(1)).await?;
    b.review(&mut child, "plan", "accept", json!([])).await?;
    b.checkpoint(&mut child, json!([{"actionKey":"a","status":"active"}]))
        .await?;
    let worker = b.worker(&child, "a", "Prepare").await?;
    b.abandon(&mut owner).await?; // new admitted Turn and the real start_work operation
    assert_closed(&s, &child)?;
    assert_terminal(&graph(&s).await?);
    let worker_state: String = db(&s)?.query_row(
        "SELECT semantic_state FROM btcc_turns WHERE turn_id=?1",
        [worker.turn],
        |r| r.get(0),
    )?;
    assert_eq!(worker_state, "cancelled");
    b.close().await?;
    s.finish().await?;
    Ok(())
}

#[tokio::test]
async fn task_graphs_steward_attempts_share_one_owner() -> Result<(), Error> {
    butler_e2e::gate!();
    let s = Setup::new("GRAPH-STEWARD-ATTEMPTS")?.start().await?;
    let mut b = GraphBuilder::open(&s.sandbox.data).await?;
    let (owner, mut first) = b
        .unplanned("butler/app-general", 1, "Release objective")
        .await?;
    b.plan(&mut first, "workers", actions(2)).await?;
    b.children
        .complete_child(
            &first.scope.session_id,
            &first.scope.turn_id,
            "cancelled",
            "Attempt cancelled".into(),
        )
        .await?;
    let mut second = b.steward(&owner, "Release objective").await?;
    b.plan(&mut second, "workers", actions(3)).await?;
    b.review(&mut second, "plan", "accept", json!([])).await?;
    b.checkpoint(&mut second, json!([{"actionKey":"a","status":"active"}]))
        .await?;
    let g = graph(&s).await?;
    assert_eq!(
        g["graph_id"],
        butler_turn::btcc::encode_task_graph_id("work:", &owner.view.work_id, "")
    );
    assert_eq!(g["nodes"].as_array().unwrap().len(), 5);
    let ids = g["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n["task_id"].as_str().unwrap())
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(ids.len(), 5);
    assert_eq!(g["counts"]["cancelled"], 2);
    assert_eq!(g["counts"]["running"], 1);
    assert_eq!(g["edges"].as_array().unwrap().len(), 3);
    let node = &g["nodes"][0];
    assert_eq!(
        s.gw.get(&format!(
            "/tasks/{}/document",
            node["task_id"].as_str().unwrap()
        ))
        .await?
        .status,
        200
    );
    b.close().await?;
    s.finish().await?;
    Ok(())
}

#[tokio::test]
async fn task_graphs_startup_repairs_orphans_and_clean_restart_writes_nothing() -> Result<(), Error>
{
    butler_e2e::gate!();
    let mut s = Setup::new("GRAPH-ORPHAN-REPAIR")?.start().await?;
    let mut b = GraphBuilder::open(&s.sandbox.data).await?;
    let (owner, mut child) = b
        .unplanned("butler/app-general", 1, "Release objective")
        .await?;
    b.plan(&mut child, "workers", actions(2)).await?;
    b.review(&mut child, "plan", "accept", json!([])).await?;
    b.checkpoint(&mut child, json!([{"actionKey":"a","status":"active"}]))
        .await?;
    b.close().await?;
    // Historical state seeded using the E2E DB fixture, never a product hook.
    db(&s)?.execute(
        "UPDATE btcc_guided_works SET status='abandoned' WHERE work_id=?1",
        [&owner.view.work_id],
    )?;
    assert_terminal(&graph(&s).await?); // projection is safe before repair
    db(&s)?.execute("INSERT INTO btcc_subsession_directions (instruction_id,relation_id,revision,source_parent_turn_id,source_message_id,instruction,status,created_at) SELECT 'orphan-direction',relation_id,1,?2,'direction-message','Continue checks','pending','2026-01-01' FROM btcc_subsession_delegations WHERE root_work_id=?1",params![child.view.work_id,owner.scope.turn_id])?;
    let turns_before: i64 =
        db(&s)?.query_row("SELECT count(*) FROM btcc_turns", [], |r| r.get(0))?;
    audit(&s)?;
    let started = std::time::Instant::now();
    s.restart().await?;
    assert_closed(&s, &child)?;
    assert_terminal(&graph(&s).await?);
    let turns_after: i64 =
        db(&s)?.query_row("SELECT count(*) FROM btcc_turns", [], |r| r.get(0))?;
    assert_eq!(
        turns_after, turns_before,
        "terminal relation must not dispatch pending directions"
    );
    let repaired = writes(&s)?;
    assert!(repaired > 0);
    eprintln!(
        "parent orphan restart_ms={} repair_audited_writes={repaired}",
        started.elapsed().as_millis()
    );
    query_plan(&s)?;
    s.restart().await?;
    assert_eq!(
        writes(&s)?,
        repaired,
        "clean restart must not write repair state"
    );
    eprintln!("clean restart repair_audited_writes=0");
    s.finish().await?;
    Ok(())
}
fn audit(s: &Scenario) -> Result<(), Error> {
    let db = db(s)?;
    db.execute_batch("CREATE TABLE e2e_repair_writes(value INTEGER);")?;
    for table in [
        "btcc_guided_works",
        "btcc_steward_results",
        "btcc_turns",
        "btcc_subsession_delegations",
        "btcc_session_relations",
    ] {
        for op in ["INSERT", "UPDATE", "DELETE"] {
            db.execute_batch(&format!("CREATE TRIGGER e2e_audit_{table}_{op} AFTER {op} ON {table} BEGIN INSERT INTO e2e_repair_writes VALUES(1); END;"))?;
        }
    }
    Ok(())
}
fn writes(s: &Scenario) -> Result<i64, Error> {
    Ok(db(s)?.query_row("SELECT count(*) FROM e2e_repair_writes", [], |r| r.get(0))?)
}
fn query_plan(s: &Scenario) -> Result<(), Error> {
    let db = db(s)?;
    let mut statement = db.prepare("EXPLAIN QUERY PLAN SELECT DISTINCT p.work_id FROM btcc_guided_works c INDEXED BY idx_btcc_work_open CROSS JOIN btcc_subsession_delegations d ON d.root_work_id=c.work_id CROSS JOIN btcc_guided_works p ON p.work_id=json_extract(d.packet_json,'$.parent_work_ref.work_id') WHERE c.status IN ('open','blocked') AND p.status IN ('completed','abandoned')")?;
    let plan = statement
        .query_map([], |r| r.get::<_, String>(3))?
        .collect::<Result<Vec<_>, _>>()?;
    assert!(plan.iter().any(|p| p.contains("idx_btcc_work_open")));
    assert!(
        !plan
            .iter()
            .any(|p| p == "SCAN d" || p == "SCAN p" || p == "SCAN c"),
        "{plan:?}"
    );
    eprintln!("orphan repair plan={plan:?}");
    // Parent lookup uses the pre-existing expression index too.
    let plan: String = db.query_row("EXPLAIN QUERY PLAN SELECT root_work_id FROM btcc_subsession_delegations WHERE json_extract(packet_json,'$.parent_work_ref.work_id')=+?1",params!["parent"],|r|r.get(3))?;
    assert!(plan.contains("idx_btcc_graph_work"), "{plan}");
    Ok(())
}
