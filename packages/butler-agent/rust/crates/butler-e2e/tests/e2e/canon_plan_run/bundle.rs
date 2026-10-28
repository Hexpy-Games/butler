use super::*;
use std::{
    sync::atomic::Ordering,
    time::{Duration, Instant},
};

#[tokio::test]
async fn quiet_hours_do_not_delay_step_turns() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, first, chat) =
        crate::canon_link::setup_at("CB-QUIET", false, false, Some("2026-10-27T06:00:00.000Z"))
            .await?;
    data(
        s.gw.patch("/settings", json!({"timezone":"UTC"})).await?,
        200,
    );
    script.quick.store(true, Ordering::SeqCst);
    data(
        s.gw.post(
            "/sessions/general/canon/queue",
            json!({"op":"start_now","epic_id":first}),
        )
        .await?,
        200,
    );
    let db = rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        s.gw.turns("general").await?;
        let delivered: i64=db.query_row("SELECT count(*) FROM app_initiated_messages i JOIN turns t ON t.user_message_id=i.message_id WHERE i.kind='canon_step' AND i.chat_id='general' AND t.state='delivered'",[],|r|r.get(0))?;
        if delivered == 1 {
            break;
        }
        assert!(Instant::now() < deadline, "step delayed during quiet hours");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(
        s.gw.messages("general")
            .await?
            .iter()
            .all(|m| m["role"] != "user")
    );
    assert_eq!(s.gw.messages(&chat).await?, [] as [serde_json::Value; 0]);
    drop(db);
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn cb_14_bundle_two_stewards_then_next() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, first, chat) = crate::canon_link::setup("CB-14", false, false).await?;
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
    let user=s.gw.post("/session-queue",json!({"chat_id":chat,"text":"What does this mean?","client_message_id":uuid::Uuid::new_v4().to_string()})).await?;
    assert_eq!(user.status, 202, "{}", user.text);
    let view = data(
        s.gw.get(&format!("/sessions/{chat}/canon/queue")).await?,
        200,
    );
    data(s.gw.post(&format!("/sessions/{chat}/canon/queue/edits"),json!({"expected_graph_revision":view["graph_revision"],"op":"join_stack","epic_id":epics[1],"target_epic_id":epics[0]})).await?,200);
    script.wait_held().await;
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let active:i64=db.query_row("SELECT count(DISTINCT l.btcc_work_id) FROM canon_epic_work_links l JOIN btcc_guided_works w ON w.work_id=l.btcc_work_id WHERE w.status='open'",[],|r|r.get(0))?;
    assert_eq!(
        active, 2,
        "both epic Works remain active behind the barrier"
    );
    assert_eq!(
        db.query_row::<i64, _, _>(
            "SELECT count(*) FROM canon_intents WHERE kind='canon_step'",
            [],
            |r| r.get(0)
        )?,
        2
    );
    drop(db);
    let app = rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    let rows: Vec<String> = app
        .prepare("SELECT text FROM session_queued_messages WHERE chat_id=?1 ORDER BY rowid")?
        .query_map([&chat], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let user = rows
        .iter()
        .position(|s| s == "What does this mean?")
        .unwrap();
    let second = rows
        .iter()
        .position(|s| s == &format!("canon:epic/{}", epics[1]))
        .unwrap();
    assert!(user < second, "{rows:?}");
    drop(app);
    script.release();
    script.release();
    wait_done(&s, &chat, 3).await?;
    s.finish().await?;
    server.abort();
    Ok(())
}
