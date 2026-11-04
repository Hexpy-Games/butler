use super::*;
#[tokio::test]
async fn cb_09_take_here_from_other_session() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, first, chat) = crate::canon_link::setup("CB-09", false, false).await?;
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
        s.gw.post(
            "/sessions",
            json!({"title":"Another conversation","kind":"chat"}),
        )
        .await?,
        201,
    );
    let other = other["session"]["id"].as_str().unwrap();
    let held = data(
        s.gw.post(
            &format!("/sessions/{other}/canon/queue"),
            json!({"op":"start_now","epic_id":epics[2]}),
        )
        .await?,
        200,
    );
    assert_eq!(held["code"], "held_elsewhere");
    assert_eq!(held["other_session"], chat);
    let running = data(
        s.gw.post(
            &format!("/sessions/{other}/canon/queue"),
            json!({"op":"start_now","epic_id":epics[0]}),
        )
        .await?,
        200,
    );
    assert_eq!(running["code"], "held_elsewhere");
    let app = rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    let offers: Vec<String> = loop {
        let mut query = app.prepare(
            "SELECT text FROM app_initiated_messages WHERE kind='canon_take_here' AND chat_id=?1",
        )?;
        let offers = query
            .query_map([other], |r| r.get(0))?
            .collect::<Result<Vec<String>, _>>()?;
        if offers.len() == 2 {
            break offers;
        }
        assert!(std::time::Instant::now() < deadline, "{offers:?}");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    };
    assert!(
        offers.iter().any(|t| t.contains("is queued in"))
            && offers.iter().any(|t| t.contains("is running in")),
        "the offer names the real state: {offers:?}"
    );
    drop(app);
    script
        .quick
        .store(true, std::sync::atomic::Ordering::SeqCst);
    data(
        s.gw.post(
            &format!("/sessions/{other}/canon/queue/take/{}", epics[2]),
            json!({}),
        )
        .await?,
        200,
    );
    assert_taken(&s, &chat, other, &epics[2], false).await?;
    script.release();
    s.finish().await?;
    server.abort();
    Ok(())
}
#[tokio::test]
async fn canon_queue_refused_in_readonly() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, _, chat) =
        crate::canon_link::setup("CB-READONLY", false, false).await?;
    data(
        s.gw.patch(
            &format!("/sessions/{chat}/controls"),
            json!({"access_mode":"read_only"}),
        )
        .await?,
        200,
    );
    let epic = script.epics.lock().unwrap()[0].clone();
    *script.queue_request.lock().unwrap() = Some(json!({"op":"start_now","epic_id":epic}));
    let accepted = s.gw.say(&chat, "Queue this epic").await?;
    s.gw.wait_terminal(
        &chat,
        &s.gw.accepted_turn(&accepted).await?,
        std::time::Duration::from_secs(30),
    )
    .await?;
    assert!(
        script
            .codes
            .lock()
            .unwrap()
            .iter()
            .any(|c| c == "read_only")
    );
    let result =
        s.gw.post(
            &format!("/sessions/{chat}/canon/queue"),
            json!({"op":"start_now","epic_id":epic}),
        )
        .await?;
    assert_eq!(result.status, 403, "{}", result.text);
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn cb_09_take_here_stops_running_source_turn() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, first, chat) = crate::canon_link::setup("CB-09", false, false).await?;
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
        s.gw.post(
            "/sessions",
            json!({"title":"Another conversation","kind":"chat"}),
        )
        .await?,
        201,
    );
    let other = other["session"]["id"].as_str().unwrap();
    let held = data(
        s.gw.post(
            &format!("/sessions/{other}/canon/queue"),
            json!({"op":"start_now","epic_id":epics[0]}),
        )
        .await?,
        200,
    );
    assert_eq!(held["code"], "held_elsewhere");
    assert_eq!(held["other_session"], chat);
    script
        .quick
        .store(true, std::sync::atomic::Ordering::SeqCst);
    data(
        s.gw.post(
            &format!("/sessions/{other}/canon/queue/take/{}", epics[0]),
            json!({}),
        )
        .await?,
        200,
    );
    assert_taken(&s, &chat, other, &epics[0], true).await?;
    script.release();
    s.finish().await?;
    server.abort();
    Ok(())
}

async fn assert_taken(
    s: &butler_e2e::e2e::scenario::Scenario,
    source: &str,
    target: &str,
    epic: &str,
    running: bool,
) -> Result<(), HarnessError> {
    let view = data(
        s.gw.get(&format!("/sessions/{target}/canon/queue")).await?,
        200,
    );
    let chains = view["chains"].as_array().unwrap();
    assert_eq!(chains.len(), 1);
    assert_eq!(chains[0]["origin"], "detach");
    assert_eq!(chains[0]["steps"][0]["items"][0]["epic_id"], epic);
    assert_eq!(chains[0]["steps"][0]["index"], 0);
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let owner: String = db.query_row(
        "SELECT session_id FROM canon_session_queue WHERE epic_id=?1",
        [epic],
        |r| r.get(0),
    )?;
    assert_eq!(owner, butler_gateway::gateway::app_session_hint(target));
    assert_eq!(
        db.query_row::<i64, _, _>(
            "SELECT count(*) FROM canon_session_queue WHERE session_id=?1 AND epic_id=?2",
            rusqlite::params![butler_gateway::gateway::app_session_hint(source), epic],
            |r| r.get(0)
        )?,
        0
    );
    assert_eq!(db.query_row::<i64,_,_>("SELECT count(*) FROM canon_session_queue WHERE session_id=?1 AND (state='held' OR hold_reason IS NOT NULL)", [butler_gateway::gateway::app_session_hint(source)], |r|r.get(0))?, 0);
    drop(db);
    let app = rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    if running {
        let state: String = app.query_row("SELECT t.state FROM turns t JOIN app_initiated_messages i ON i.message_id=t.user_message_id WHERE i.chat_id=?1 AND json_extract(i.payload_json,'$.epic_id')=?2", rusqlite::params![source,epic], |r|r.get(0))?;
        assert_eq!(state, "cancelled");
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        let taken: i64 = app.query_row("SELECT count(*) FROM app_initiated_messages WHERE chat_id=?1 AND kind='canon_take_here' AND json_extract(payload_json,'$.panel.state')='taken'", [target], |r|r.get(0))?;
        if taken == 1 {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "take panel was not taken"
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert_eq!(
        app.query_row::<i64, _, _>(
            "SELECT count(*) FROM app_initiated_messages WHERE chat_id=?1 AND kind='canon_hold'",
            [source],
            |r| r.get(0)
        )?,
        0
    );
    Ok(())
}
