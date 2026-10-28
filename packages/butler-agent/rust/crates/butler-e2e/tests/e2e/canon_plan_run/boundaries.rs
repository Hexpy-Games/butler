use super::*;
use std::sync::atomic::Ordering;

#[tokio::test]
async fn user_epic_text_is_not_a_step() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, first, chat) =
        crate::canon_link::setup("CB-USER-TEXT", false, false).await?;
    script.quick.store(true, Ordering::SeqCst);
    let accepted = s.gw.say(&chat, &format!("canon:epic/{first}")).await?;
    s.gw.wait_terminal(
        &chat,
        &butler_e2e::e2e::scenario::accepted_turn_id(&accepted)?,
        std::time::Duration::from_secs(30),
    )
    .await?;
    assert!(!script.step_seen.load(Ordering::SeqCst));
    let view = data(
        s.gw.get(&format!("/sessions/{chat}/canon/queue")).await?,
        200,
    );
    assert_eq!(view["chains"], json!([]));
    data(
        s.gw.post(
            &format!("/sessions/{chat}/canon/queue"),
            json!({"op":"start_now","epic_id":first}),
        )
        .await?,
        200,
    );
    let original = butler_e2e::e2e::scenario::accepted_turn_id(&accepted)?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    let step = loop {
        if let Some(turn) =
            s.gw.turns(&chat)
                .await?
                .iter()
                .find(|t| t["id"] != original)
        {
            break turn["id"].as_str().unwrap().to_owned();
        }
        assert!(
            std::time::Instant::now() < deadline,
            "step was not admitted"
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    };
    s.gw.wait_terminal(&chat, &step, std::time::Duration::from_secs(30))
        .await?;
    assert!(
        script.step_seen.load(Ordering::SeqCst),
        "real step instructions were missing"
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn remove_elsewhere_returns_feedback_without_take_card() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, first, chat) =
        crate::canon_link::setup("CB-REMOVE-ELSEWHERE", false, false).await?;
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
    let other = data(
        s.gw.post("/sessions", json!({"title":"Other","kind":"chat"}))
            .await?,
        201,
    );
    let other = other["session"]["id"].as_str().unwrap();
    *script.queue_request.lock().unwrap() = Some(json!({"op":"remove","epic_id":epics[2]}));
    let accepted = s.gw.say(other, "Queue this epic").await?;
    s.gw.wait_terminal(
        other,
        &butler_e2e::e2e::scenario::accepted_turn_id(&accepted)?,
        std::time::Duration::from_secs(30),
    )
    .await?;
    assert!(
        script
            .codes
            .lock()
            .unwrap()
            .iter()
            .any(|c| c == "not_queued_here")
    );
    let app = rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    assert_eq!(
        app.query_row::<i64, _, _>(
            "SELECT count(*) FROM app_initiated_messages WHERE kind='canon_take_here'",
            [],
            |r| r.get(0)
        )?,
        0
    );
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    assert_eq!(
        db.query_row::<i64, _, _>(
            "SELECT count(*) FROM canon_intents WHERE kind='canon_take_here'",
            [],
            |r| r.get(0)
        )?,
        0
    );
    let state: String = db.query_row(
        "SELECT state FROM canon_session_queue WHERE epic_id=?1",
        [&epics[2]],
        |r| r.get(0),
    )?;
    assert_eq!(state, "waiting");
    drop(db);
    drop(app);
    script.release();
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn queue_plan_stays_with_chain_and_mixed_plans_are_null() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, first, chat) =
        crate::canon_link::setup("CB-QUEUE-PLAN", false, false).await?;
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
    let epic = data(s.gw.get(&format!("/canon/epics/{}", epics[0])).await?, 200);
    let other_plan = data(
        s.gw.post(
            &format!(
                "/projects/{}/canon/plans",
                epic["project_id"].as_str().unwrap()
            ),
            json!({"title":"Later plan"}),
        )
        .await?,
        201,
    );
    data(
        s.gw.patch(
            &format!("/canon/epics/{}", epics[0]),
            json!({"expected_revision":epic["revision"],"plan_id":other_plan["id"]}),
        )
        .await?,
        200,
    );
    let view = data(
        s.gw.get(&format!("/sessions/{chat}/canon/queue")).await?,
        200,
    );
    assert_eq!(
        view["plan"]["id"], plan,
        "chain keeps its starting plan after an epic moves"
    );
    let new_epic = data(
        s.gw.post(
            &format!(
                "/projects/{}/canon/epics",
                epic["project_id"].as_str().unwrap()
            ),
            json!({"title":"Other goal","plan_id":other_plan["id"]}),
        )
        .await?,
        201,
    );
    data(
        s.gw.post(
            &format!("/sessions/{chat}/canon/queue"),
            json!({"op":"start_now","epic_id":new_epic["id"]}),
        )
        .await?,
        200,
    );
    let view = data(
        s.gw.get(&format!("/sessions/{chat}/canon/queue")).await?,
        200,
    );
    assert!(view["plan"].is_null());
    script.quick.store(true, Ordering::SeqCst);
    script.release();
    s.finish().await?;
    server.abort();
    Ok(())
}
