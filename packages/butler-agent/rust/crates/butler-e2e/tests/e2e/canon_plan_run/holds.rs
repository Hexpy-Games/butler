use super::*;
use serde_json::Value;

async fn blocked(decision: &str) -> Result<(), HarnessError> {
    let (mut s, script, server, first, chat) =
        crate::canon_link::setup("CB-08", false, false).await?;
    let (plan, epics) = plan(&s, &script, &first).await?;
    script.blocked.lock().unwrap().push(epics[1].clone());
    script.release();
    data(
        s.gw.post(
            &format!("/sessions/{chat}/canon/queue"),
            json!({"op":"plan_run","plan_id":plan}),
        )
        .await?,
        200,
    );
    wait_state(&s, &chat, &epics[2], "held").await?;
    assert_eq!(hold_cards(&s).await?, 1);
    s.restart().await?;
    wait_state(&s, &chat, &epics[2], "held").await?;
    assert_eq!(hold_cards(&s).await?, 1);
    data(
        s.gw.post(
            &format!("/sessions/{chat}/canon/queue/holds/{}", epics[1]),
            json!({"decision":decision}),
        )
        .await?,
        200,
    );
    wait_done(&s, &chat, if decision == "delete" { 2 } else { 3 }).await?;
    s.restart().await?;
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let saved: String = db.query_row(
        "SELECT decision FROM canon_session_queue WHERE epic_id=?1",
        [&epics[1]],
        |r| r.get(0),
    )?;
    assert_eq!(saved, decision);
    drop(db);
    let app = rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    let states:Vec<String>=app.prepare("SELECT json_extract(payload_json,'$.panel.state') FROM app_initiated_messages WHERE kind='canon_hold'")?.query_map([],|r|r.get(0))?.collect::<rusqlite::Result<_>>()?;
    assert_eq!(
        states,
        [if decision == "delete" {
            "deleted"
        } else {
            "continued"
        }]
    );
    drop(app);
    s.finish().await?;
    server.abort();
    Ok(())
}
#[tokio::test]
async fn cb_08_blocked_holds_then_delete() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    blocked("delete").await
}
#[tokio::test]
async fn cb_08_blocked_holds_then_continue() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    blocked("continue").await
}
async fn hold_cards(s: &butler_e2e::e2e::scenario::Scenario) -> Result<i64, HarnessError> {
    let db = rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        let count = db.query_row(
            "SELECT count(*) FROM app_initiated_messages WHERE kind='canon_hold'",
            [],
            |r| r.get::<_, i64>(0),
        )?;
        if count > 0 {
            return Ok(count);
        }
        assert!(
            std::time::Instant::now() < deadline,
            "hold card was not projected"
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}
pub(super) async fn wait_state(
    s: &butler_e2e::e2e::scenario::Scenario,
    chat: &str,
    epic: &str,
    state: &str,
) -> Result<Value, HarnessError> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    loop {
        let view = data(
            s.gw.get(&format!("/sessions/{chat}/canon/queue")).await?,
            200,
        );
        if view["chains"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|c| c["steps"].as_array().unwrap())
            .flat_map(|s| s["items"].as_array().unwrap())
            .any(|i| i["epic_id"] == epic && i["state"] == state)
        {
            return Ok(view);
        }
        assert!(std::time::Instant::now() < deadline, "{view}");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}
