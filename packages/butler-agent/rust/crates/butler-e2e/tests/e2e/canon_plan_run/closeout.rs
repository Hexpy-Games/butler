use super::*;
use butler_e2e::e2e::scenario::Scenario;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

/// A model may close direct Work with its plan review alone; BTCC accepts that
/// closeout, so the queue must not wait for reviews that never come.
#[tokio::test]
async fn plan_run_advances_when_work_closes_without_later_reviews() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, first, chat) =
        crate::canon_link::setup("CB-CLOSEOUT", false, false).await?;
    let (plan, epics) = plan(&s, &script, &first).await?;
    script.plan_review_only.store(true, Ordering::SeqCst);
    script.release();
    data(
        s.gw.post(
            &format!("/sessions/{chat}/canon/queue"),
            json!({"op":"plan_run","plan_id":plan}),
        )
        .await?,
        200,
    );
    let view = wait_done(&s, &chat, 3).await?;
    assert_eq!(view["counts"]["held"], 0, "{view}");
    for epic in &epics {
        let row = data(s.gw.get(&format!("/canon/epics/{epic}")).await?, 200);
        assert_eq!(row["canon_status"], "in_review", "{row}");
        assert_eq!(row["running"], json!(false), "{row}");
    }
    s.finish().await?;
    server.abort();
    Ok(())
}

async fn wait_idle(s: &Scenario, epic: &str) -> Result<serde_json::Value, HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let row = data(s.gw.get(&format!("/canon/epics/{epic}")).await?, 200);
        if row["running"] == json!(false) {
            return Ok(row);
        }
        assert!(Instant::now() < deadline, "epic stays running: {row}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// A deleted conversation cannot answer anything, so its running step must stop.
#[tokio::test]
async fn deleting_chat_stops_its_running_step() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, first, chat) =
        crate::canon_link::setup("CB-DELETE-RUNNING", false, false).await?;
    let (plan, epics) = plan(&s, &script, &first).await?;
    data(
        s.gw.post(
            &format!("/sessions/{chat}/canon/queue"),
            json!({"op":"plan_run","plan_id":plan}),
        )
        .await?,
        200,
    );
    script.wait_held().await;
    let model_calls = script.requests.lock().unwrap().len();
    data(
        s.gw.delete(&format!("/sessions/{chat}?permanent=true"))
            .await?,
        200,
    );
    wait_idle(&s, &epics[0]).await?;
    script.release();
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(
        script.requests.lock().unwrap().len(),
        model_calls,
        "a deleted conversation keeps calling the model"
    );
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    assert_eq!(
        db.query_row::<i64, _, _>(
            "SELECT count(*) FROM btcc_guided_works WHERE status='completed'",
            [],
            |r| r.get(0)
        )?,
        0,
        "the stopped step must not complete its Work"
    );
    drop(db);
    s.finish().await?;
    server.abort();
    Ok(())
}

/// A step waiting on an approval card had no way out once its chat was gone.
#[tokio::test]
async fn deleting_chat_settles_step_waiting_for_approval() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, first, chat) =
        crate::canon_link::setup("CB-DELETE-APPROVAL", false, false).await?;
    let (plan, epics) = plan(&s, &script, &first).await?;
    data(
        s.gw.patch("/settings", json!({"access_mode":"ask_first"}))
            .await?,
        200,
    );
    let outside = s.sandbox.home.join("outside-the-workspace.txt");
    std::fs::write(&outside, "Needs an approval to read.")?;
    *script.path.lock().unwrap() = outside.to_string_lossy().into_owned();
    data(
        s.gw.post(
            &format!("/sessions/{chat}/canon/queue"),
            json!({"op":"plan_run","plan_id":plan}),
        )
        .await?,
        200,
    );
    let deadline = Instant::now() + Duration::from_secs(30);
    while s.gw.approval_requests(&chat).await?.is_empty() {
        assert!(Instant::now() < deadline, "approval never appeared");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    data(
        s.gw.delete(&format!("/sessions/{chat}?permanent=true"))
            .await?,
        200,
    );
    wait_idle(&s, &epics[0]).await?;
    script.release();
    s.finish().await?;
    server.abort();
    Ok(())
}

/// A delegated step has no live chat Turn to stop: its Steward must stop with the chat.
#[tokio::test]
async fn deleting_chat_stops_its_delegated_step() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, first, chat) =
        crate::canon_link::setup("CB-DELETE-DELEGATED", false, false).await?;
    let (plan, epics) = plan(&s, &script, &first).await?;
    script.delegate.store(true, Ordering::SeqCst);
    data(
        s.gw.post(
            &format!("/sessions/{chat}/canon/queue"),
            json!({"op":"plan_run","plan_id":plan}),
        )
        .await?,
        200,
    );
    script.wait_held().await;
    data(
        s.gw.delete(&format!("/sessions/{chat}?permanent=true"))
            .await?,
        200,
    );
    wait_idle(&s, &epics[0]).await?;
    script.release();
    tokio::time::sleep(Duration::from_millis(500)).await;
    wait_idle(&s, &epics[0]).await?;
    s.finish().await?;
    server.abort();
    Ok(())
}
