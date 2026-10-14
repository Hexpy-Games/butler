//! BTCC fidelity through real gateway reads, driven by the Work/Subsession services.
use super::*;
use butler_e2e::e2e::scenario::Scenario;
use butler_e2e::e2e::task_graph::{Error, GraphBuilder, GraphWork, actions};
use serde_json::Value;

async fn graph(s: &Scenario, work: &GraphWork) -> Result<Value, Error> {
    let id = butler_turn::btcc::encode_task_graph_id("work:", &work.view.work_id, "");
    let reply = s.gw.get(&format!("/plans/{id}/task-graph")).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    Ok(reply.data().clone())
}
async fn only_graph(s: &Scenario, parent: &str) -> Result<(), Error> {
    let list = s.gw.get(&format!("/sessions/{parent}/task-graphs")).await?;
    assert_eq!(list.status, 200, "{}", list.text);
    assert_eq!(list.data()["total"], 1);
    assert_eq!(list.data()["graphs"][0]["title"], "Release objective");
    Ok(())
}

#[tokio::test]
async fn task_graphs_btcc_main_path() -> Result<(), Error> {
    butler_e2e::gate!();
    let s = Setup::new("TASK-GRAPH-MAIN")?.start().await?;
    let mut builder = GraphBuilder::open(&s.sandbox.data).await?;
    let mut work = builder
        .graph("butler/app-general", 4, "Release objective")
        .await?;
    only_graph(&s, "general").await?;
    let initial = graph(&s, &work).await?;
    let ids: Vec<_> = initial["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n["task_id"].clone())
        .collect();
    let selected = ids[0].clone();
    let a = builder.worker(&work, "a", "Prepare first").await?;
    builder
        .checkpoint(&mut work, json!([{"actionKey":"a","status":"active"}]))
        .await?;
    assert_eq!(graph(&s, &work).await?["nodes"][0]["status"], "running");
    builder.result(&a, "success", "Preparation checked").await?;
    assert_eq!(graph(&s, &work).await?["nodes"][0]["status"], "review");
    builder
        .checkpoint(&mut work, json!([{"actionKey":"a","status":"done"}]))
        .await?;
    let b = builder.worker(&work, "b", "Build independently").await?;
    let c = builder.worker(&work, "c", "Check independently").await?;
    builder
        .checkpoint(
            &mut work,
            json!([{"actionKey":"b","status":"active"},{"actionKey":"c","status":"active"}]),
        )
        .await?;
    let fanout = graph(&s, &work).await?;
    assert_eq!(fanout["nodes"][0]["status"], "done");
    assert_eq!(fanout["nodes"][1]["status"], "running");
    assert_eq!(fanout["nodes"][2]["status"], "running");
    assert_eq!(fanout["nodes"][3]["status"], "pending");
    assert!(builder.worker(&work, "d", "Join too early").await.is_err());
    builder.result(&b, "success", "Build checked").await?;
    builder
        .checkpoint(&mut work, json!([{"actionKey":"b","status":"done"}]))
        .await?;
    assert!(builder.worker(&work, "d", "Still too early").await.is_err());
    builder.result(&c, "success", "Check complete").await?;
    builder
        .checkpoint(&mut work, json!([{"actionKey":"c","status":"done"}]))
        .await?;
    let _d = builder.worker(&work, "d", "Integrate both results").await?;
    builder
        .checkpoint(&mut work, json!([{"actionKey":"d","status":"active"}]))
        .await?;
    let latest = graph(&s, &work).await?;
    assert_eq!(
        latest["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n["task_id"].clone())
            .collect::<Vec<_>>(),
        ids
    );
    assert_eq!(latest["nodes"][0]["task_id"], selected);
    assert_eq!(
        latest["edges"],
        json!([{"from":ids[0],"to":ids[1]},{"from":ids[0],"to":ids[2]},{"from":ids[1],"to":ids[3]},{"from":ids[2],"to":ids[3]}])
    );
    assert_eq!(
        latest["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n["rank"].as_u64().unwrap())
            .collect::<Vec<_>>(),
        [0, 1, 1, 2]
    );
    only_graph(&s, "general").await?;
    builder.close().await?;
    s.finish().await?;
    Ok(())
}

#[tokio::test]
async fn task_graphs_btcc_revise_and_attempt_history() -> Result<(), Error> {
    butler_e2e::gate!();
    let s = Setup::new("TASK-GRAPH-REVISE")?.start().await?;
    let mut builder = GraphBuilder::open(&s.sandbox.data).await?;
    let mut work = builder
        .graph("butler/app-general", 4, "Release objective")
        .await?;
    builder
        .checkpoint(
            &mut work,
            json!([{"actionKey":"a","status":"done"},{"actionKey":"c","status":"active"}]),
        )
        .await?;
    let first = builder.worker(&work, "c", "First check").await?;
    builder
        .result(&first, "success", "First check result")
        .await?;
    let original = graph(&s, &work).await?;
    builder
        .review(
            &mut work,
            "result",
            "revise",
            json!([{"actionKey":"c","status":"active"}]),
        )
        .await?;
    let revised = graph(&s, &work).await?;
    assert_eq!(revised["nodes"][2]["reason_code"], "review_revised");
    assert_eq!(revised["nodes"][2]["status"], "pending");
    assert_eq!(revised["nodes"][2]["review"]["verdict"], "revise");
    let second = builder
        .worker(&work, "c", "Correct the implementation")
        .await?;
    let latest = graph(&s, &work).await?;
    assert_eq!(
        latest["nodes"][2]["task_id"],
        original["nodes"][2]["task_id"]
    );
    assert_eq!(latest["nodes"][2]["status"], "running");
    assert_eq!(latest["nodes"][2]["attempts"].as_array().unwrap().len(), 2);
    assert_eq!(latest["nodes"][2]["attempts"][0]["task_id"], first.task);
    assert_eq!(
        latest["nodes"][2]["attempts"][0]["summary"],
        "First check result"
    );
    assert_eq!(latest["nodes"][2]["session_id"], second.session);
    only_graph(&s, "general").await?;
    builder.close().await?;
    s.finish().await?;
    Ok(())
}

#[tokio::test]
async fn task_graphs_btcc_replan_keeps_work_identity() -> Result<(), Error> {
    butler_e2e::gate!();
    let s = Setup::new("TASK-GRAPH-REPLAN")?.start().await?;
    let mut builder = GraphBuilder::open(&s.sandbox.data).await?;
    let mut work = builder
        .graph("butler/app-general", 4, "Release objective")
        .await?;
    let _a = builder.worker(&work, "a", "Prepare").await?;
    let before = graph(&s, &work).await?;
    builder.plan(&mut work, "workers", actions(5)).await?;
    let after = graph(&s, &work).await?;
    assert_eq!(after["graph_id"], before["graph_id"]);
    assert_eq!(after["nodes"][0]["task_id"], before["nodes"][0]["task_id"]);
    assert_eq!(
        after["nodes"][0]["attempts"],
        before["nodes"][0]["attempts"]
    );
    assert_eq!(after["nodes"].as_array().unwrap().len(), 5);
    assert_ne!(after["graph_revision"], before["graph_revision"]);
    only_graph(&s, "general").await?;
    builder.plan(&mut work, "direct", actions(5)).await?;
    builder
        .checkpoint(&mut work, json!([{"actionKey":"a","status":"active"}]))
        .await?;
    let direct = graph(&s, &work).await?;
    assert_eq!(direct["nodes"][0]["handled_directly"], true);
    assert_eq!(direct["nodes"][0]["session_id"], work.scope.session_id);
    assert_eq!(
        direct["nodes"][0]["attempts"],
        before["nodes"][0]["attempts"]
    );
    builder.close().await?;
    s.finish().await?;
    Ok(())
}

#[tokio::test]
async fn task_graphs_btcc_skip_satisfies_join() -> Result<(), Error> {
    butler_e2e::gate!();
    let s = Setup::new("TASK-GRAPH-SKIP")?.start().await?;
    let mut builder = GraphBuilder::open(&s.sandbox.data).await?;
    let mut work = builder
        .graph("butler/app-general", 4, "Release objective")
        .await?;
    builder.checkpoint(&mut work,json!([{"actionKey":"a","status":"done"},{"actionKey":"b","status":"done"},{"actionKey":"c","status":"skipped"}])).await?;
    let _d = builder.worker(&work, "d", "Join after skip").await?;
    let latest = graph(&s, &work).await?;
    assert_eq!(latest["nodes"][2]["status"], "skipped");
    assert_eq!(latest["counts"]["cancelled"], 0);
    assert_ne!(latest["state"], "cancelled");
    assert_eq!(latest["edges"].as_array().unwrap().len(), 4);
    builder.close().await?;
    s.finish().await?;
    Ok(())
}

#[tokio::test]
async fn task_graphs_btcc_failure_does_not_block_successor() -> Result<(), Error> {
    butler_e2e::gate!();
    let s = Setup::new("TASK-GRAPH-FAIL")?.start().await?;
    let mut builder = GraphBuilder::open(&s.sandbox.data).await?;
    let mut work = builder
        .graph("butler/app-general", 4, "Release objective")
        .await?;
    let a = builder.worker(&work, "a", "Prepare").await?;
    builder
        .checkpoint(&mut work, json!([{"actionKey":"a","status":"active"}]))
        .await?;
    builder
        .result(&a, "failed", "Build failed\n token=synthetic-credential")
        .await?;
    let latest = graph(&s, &work).await?;
    assert_eq!(latest["nodes"][0]["status"], "failed");
    assert_eq!(latest["nodes"][0]["reason_code"], "attempt_failed");
    assert_eq!(
        latest["nodes"][0]["blocked_reason"],
        "Build failed [redacted]"
    );
    assert_eq!(latest["nodes"][1]["status"], "pending");
    assert_eq!(latest["nodes"][2]["status"], "pending");
    builder.close().await?;
    s.finish().await?;
    Ok(())
}

#[tokio::test]
async fn task_graphs_btcc_phase_validation_reporting() -> Result<(), Error> {
    butler_e2e::gate!();
    let s = Setup::new("TASK-GRAPH-PHASE")?.start().await?;
    let mut builder = GraphBuilder::open(&s.sandbox.data).await?;
    let mut work = builder
        .graph("butler/app-general", 1, "Release objective")
        .await?;
    assert_eq!(graph(&s, &work).await?["phase"], "execution");
    builder
        .checkpoint(&mut work, json!([{"actionKey":"a","status":"done"}]))
        .await?;
    builder
        .review(&mut work, "result", "accept", json!([]))
        .await?;
    assert_eq!(graph(&s, &work).await?["phase"], "validation");
    builder
        .review(&mut work, "completion", "accept", json!([]))
        .await?;
    assert_eq!(graph(&s, &work).await?["phase"], "reporting");
    builder.complete(&mut work).await?;
    let latest = graph(&s, &work).await?;
    assert_eq!(latest["work_state"], "completed");
    assert_eq!(latest["state"], "done");
    builder.close().await?;
    s.finish().await?;
    Ok(())
}

#[tokio::test]
async fn task_graphs_btcc_reads_and_idle_are_write_free() -> Result<(), Error> {
    use super::super::data_perf::wal::Wal;
    use std::time::Duration;
    butler_e2e::gate!();
    let s = Setup::new("TASK-GRAPH-HOUSEKEEPING")?.start().await?;
    let mut builder = GraphBuilder::open(&s.sandbox.data).await?;
    let work = builder
        .graph("butler/app-general", 4, "Release objective")
        .await?;
    let first = graph(&s, &work).await?;
    let text = first["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n["title"].as_str().unwrap())
        .collect::<Vec<_>>()
        .join(" ");
    for hidden in ["Steward", "스튜어드", "delegate_to_", "WorkModel", "위임"] {
        assert!(!text.contains(hidden));
    }
    builder.close().await?;
    tokio::time::sleep(Duration::from_millis(1200)).await;
    let pins = [
        "agent-runtime/btcc.sqlite",
        "app-server/butler-client.sqlite",
    ]
    .map(|p| Wal::pin(&s.sandbox.data, p))
    .into_iter()
    .collect::<Result<Vec<_>, _>>()?;
    let before = pins
        .iter()
        .map(Wal::sample)
        .collect::<Result<Vec<_>, _>>()?;
    let list = s.gw.get("/sessions/general/task-graphs").await?;
    assert_eq!(list.data()["total"], 1);
    let id = first["graph_id"].as_str().unwrap();
    assert_eq!(
        s.gw.get(&format!("/plans/{id}/task-graph")).await?.data()["nodes"],
        first["nodes"]
    );
    let node = first["nodes"][0]["task_id"].as_str().unwrap();
    assert_eq!(
        s.gw.get(&format!("/tasks/{node}/document")).await?.status,
        200
    );
    tokio::time::sleep(Duration::from_millis(2200)).await;
    for (pin, before) in pins.iter().zip(before) {
        assert_eq!(
            pin.delta(before)?,
            (0, 0),
            "{}: read/idle wrote WAL",
            pin.name
        );
    }
    eprintln!("TASK-GRAPH-HOUSEKEEPING idle_ms=2200 wal_bytes=0 commits=0");
    drop(pins);
    s.finish().await?;
    Ok(())
}
