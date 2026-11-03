//! Nested Workers appear only in the panel, with pushed invalidation from their Steward.
use super::*;
use crate::worker_cap;

#[tokio::test]
async fn subtask_workers_are_ordered_live_and_retained_when_finished() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server) = worker_cap::setup("SUBTASK-WORKERS", 4).await?;
    let live = LiveEvents::subscribe(&s.gw, 0).await?;
    s.gw.say("general", "Verify batch red").await?;
    let (subtask, _) = worker_cap::workers(&s, "general", 3).await?;
    worker_cap::started(&script, 2).await;
    script.fourth.add_permits(1);
    let (_, rows) = worker_cap::workers(&s, "general", 4).await?;
    live.wait_for(Duration::from_secs(20), |event| {
        event["type"] == "subsession.changed"
            && event["payload"]["session_id"] == subtask
            && event["payload"]["child_session_id"] == rows[0]["session_id"]
    })
    .await?;
    let view = general_view(&s).await?;
    assert_workers(
        &view["subtasks"][0],
        &rows,
        &["active", "active", "waiting", "waiting"],
    );
    assert_eq!(view["workers"], serde_json::json!([]), "{view}");
    let after = live
        .snapshot()
        .last()
        .and_then(|event| event["id"].as_u64());
    script.release("red-0");
    worker_cap::closed(&s, rows[0]["session_id"].as_str().unwrap()).await?;
    worker_cap::started(&script, 3).await;
    // A new pushed event for this exact Worker, after the release.
    live.wait_for(Duration::from_secs(20), |event| {
        event["id"].as_u64() > after
            && event["type"] == "subsession.changed"
            && event["payload"]["session_id"] == subtask
            && event["payload"]["child_session_id"] == rows[0]["session_id"]
    })
    .await?;
    let view = general_view(&s).await?;
    assert_workers(
        &view["subtasks"][0],
        &rows,
        &["completed", "active", "active", "waiting"],
    );
    let parent = navigation_chat(&s, "general").await?;
    let tasks = parent["subtasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 1, "{parent}");
    assert_eq!(tasks[0]["session_id"], subtask);
    assert!(tasks[0].get("workers").is_none(), "{parent}");
    for key in ["red-1", "red-2", "red-3"] {
        script.release(key);
    }
    for row in &rows[1..] {
        worker_cap::closed(&s, row["session_id"].as_str().unwrap()).await?;
    }
    s.finish().await?;
    server.abort();
    Ok(())
}

fn assert_workers(subtask: &Value, rows: &[Value], statuses: &[&str]) {
    let workers = subtask["workers"].as_array().unwrap();
    assert_eq!(workers.len(), rows.len(), "{subtask}");
    for (index, worker) in workers.iter().enumerate() {
        assert_eq!(worker["session_id"], rows[index]["session_id"]);
        assert_eq!(
            worker["relation_id"],
            rows[index]["relation"]["relation_id"]
        );
        assert_eq!(worker["title"], format!("Verify red-{index}"));
        assert_eq!(worker["title"], rows[index]["title"]);
        assert_eq!(worker["status"], statuses[index], "{subtask}");
    }
}
