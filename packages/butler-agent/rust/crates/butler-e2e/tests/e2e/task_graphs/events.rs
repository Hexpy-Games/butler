//! Durable graph SSE revision, snapshot race and reconnect through public routes.
use super::*;
use butler_e2e::e2e::events::LiveEvents;
use std::time::Duration;

#[tokio::test]
async fn task_graphs_revision_event_and_reconnect() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("TASK-GRAPH-SSE")?
        .cassette("TURN-01")
        .replay_only()
        .start()
        .await?;
    let created = s.gw.post("/sessions", json!({"kind":"chat"})).await?;
    let hint = created.data()["session"]["session_hint"]
        .as_str()
        .unwrap()
        .to_owned();
    let ids = Box::pin(fixture::seed(&s.sandbox.data, &hint, 1)).await?;
    let id = &ids[0];
    let graph = s.gw.get(&format!("/plans/{id}/task-graph")).await?;
    let seq = graph.data()["event_seq"].as_u64().unwrap();
    let page = s.gw.get(&format!("/plans/{id}/task-graph?limit=2")).await?;
    let stream = LiveEvents::subscribe(&s.gw, seq).await?;
    // A committed source fixture change; the next real stub turn wakes the
    // canonical storage change signal. No test-only graph publisher is used.
    wake(&s, id).await?;
    let changed = stream
        .wait_for(Duration::from_secs(10), |e| {
            e["type"] == "work_model.changed" && e["payload"]["plan_id"] == graph.data()["graph_id"]
        })
        .await?;
    let latest = s.gw.get(&format!("/plans/{id}/task-graph")).await?;
    assert_eq!(
        s.gw.get(&format!(
            "/plans/{id}/task-graph?cursor={}",
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
    wake(&s, id).await?;
    let next = stream
        .wait_for(Duration::from_secs(10), |e| {
            e["type"] == "work_model.changed"
                && e["payload"]["plan_id"] == graph.data()["graph_id"]
                && e["payload"]["graph_revision"] != changed["payload"]["graph_revision"]
        })
        .await?;
    let latest = s.gw.get(&format!("/plans/{id}/task-graph")).await?;
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

async fn wake(s: &butler_e2e::e2e::scenario::Scenario, id: &str) -> Result<(), HarnessError> {
    let mut builder = butler_e2e::e2e::task_graph::GraphBuilder::open(&s.sandbox.data)
        .await
        .map_err(fixture::error)?;
    let mut work = builder
        .existing(&s.sandbox.data, id)
        .await
        .map_err(fixture::error)?;
    builder
        .checkpoint(&mut work, json!([]))
        .await
        .map_err(fixture::error)?;
    builder.close().await.map_err(fixture::error)?;
    // The next genuine gateway turn wakes its connection's change signal.
    s.turn("general","Write the numbers from one to twelve as English words, separated by single spaces, and nothing else.").await?;
    Ok(())
}

fn assert_patches(payload: &serde_json::Value, graph: &serde_json::Value) {
    assert_eq!(payload["graph_revision"], graph["graph_revision"]);
    assert_eq!(payload["counts"], graph["counts"]);
    assert_eq!(payload["edges"], graph["edges"]);
    assert_eq!(payload["phase"], graph["phase"]);
    assert_eq!(payload["work_state"], graph["work_state"]);
    assert_eq!(
        payload["node_order"],
        json!(
            graph["nodes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|n| n["task_id"].clone())
                .collect::<Vec<_>>()
        )
    );
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
