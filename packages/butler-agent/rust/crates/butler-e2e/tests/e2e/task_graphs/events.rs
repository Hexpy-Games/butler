//! Durable graph SSE revision, snapshot race and reconnect through public routes.
use super::*;
use butler_e2e::e2e::events::LiveEvents;
use std::time::Duration;

#[tokio::test]
async fn task_graphs_revision_event_and_reconnect() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("TASK-GRAPH-SSE")?
        .cassette("TURN-01")
        .replay_only()
        .start()
        .await?;
    let created = s.gw.post("/sessions", json!({"kind":"chat"})).await?;
    let hint = created.data()["session"]["session_hint"]
        .as_str()
        .unwrap()
        .to_owned();
    s.agent.terminate().await?;
    fixture::seed(&s.sandbox.data, &hint, 1)?;
    s.gw = s.agent.start_again().await?;
    let graph = s.gw.get("/plans/graph-1-0/task-graph").await?;
    let seq = graph.data()["event_seq"].as_u64().unwrap();
    let page = s.gw.get("/plans/graph-1-0/task-graph?limit=2").await?;
    let stream = LiveEvents::subscribe(&s.gw, seq).await?;
    // A committed source fixture change; the next real stub turn wakes the
    // canonical storage change signal. No test-only graph publisher is used.
    wake(&s, "2026-10-02T00:00:00Z").await?;
    let changed = stream
        .wait_for(Duration::from_secs(10), |e| {
            e["type"] == "work_model.changed" && e["payload"]["plan_id"] == "graph-1-0"
        })
        .await?;
    let latest = s.gw.get("/plans/graph-1-0/task-graph").await?;
    assert_eq!(
        s.gw.get(&format!(
            "/plans/graph-1-0/task-graph?cursor={}",
            page.data()["cursor"].as_str().unwrap()
        ))
        .await?
        .status,
        409
    );
    assert_ne!(
        latest.data()["graph_revision"],
        graph.data()["graph_revision"]
    );
    assert_eq!(
        changed["payload"]["graph_revision"],
        latest.data()["graph_revision"]
    );
    assert_eq!(changed["payload"]["event_seq"], changed["id"]);
    assert_eq!(changed["payload"]["counts"], latest.data()["counts"]);
    assert_patches(&changed["payload"], latest.data());
    wake(&s, "2026-10-03T00:00:00Z").await?;
    let next = stream
        .wait_for(Duration::from_secs(10), |e| {
            e["type"] == "work_model.changed"
                && e["payload"]["plan_id"] == "graph-1-0"
                && e["payload"]["graph_revision"] != changed["payload"]["graph_revision"]
        })
        .await?;
    let latest = s.gw.get("/plans/graph-1-0/task-graph").await?;
    assert_eq!(
        next["payload"]["previous_graph_revision"],
        changed["payload"]["graph_revision"]
    );
    assert_eq!(next["payload"]["refetch"], false);
    assert_patches(&next["payload"], latest.data());
    let reconnected = LiveEvents::subscribe(&s.gw, seq).await?;
    let replay = reconnected
        .wait_for(Duration::from_secs(5), |e| e["id"] == changed["id"])
        .await?;
    assert_eq!(replay, changed);
    drop(reconnected);
    drop(stream);
    s.finish().await
}

async fn wake(s: &butler_e2e::e2e::scenario::Scenario, date: &str) -> Result<(), HarnessError> {
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    db.execute("UPDATE btcc_guided_works SET objective='New release',updated_at=?1 WHERE work_id='source-1-0'",[date])?;
    drop(db);
    s.turn("general","Write the numbers from one to twelve as English words, separated by single spaces, and nothing else.").await?;
    Ok(())
}

fn assert_patches(payload: &serde_json::Value, graph: &serde_json::Value) {
    assert_eq!(payload["graph_revision"], graph["graph_revision"]);
    assert_eq!(payload["counts"], graph["counts"]);
    assert_eq!(payload["edges"], graph["edges"]);
    let changes = payload["entity_changes"].as_array().unwrap();
    let nodes = graph["nodes"].as_array().unwrap();
    assert_eq!(changes.len(), nodes.len());
    for change in changes {
        assert_eq!(change["type"], "upsert");
        assert_eq!(
            &change["node"],
            nodes
                .iter()
                .find(|n| n["task_id"] == change["task_id"])
                .unwrap()
        );
    }
}
