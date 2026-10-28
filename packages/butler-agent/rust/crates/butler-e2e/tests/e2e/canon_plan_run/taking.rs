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
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    assert_eq!(
        db.query_row::<i64, _, _>(
            "SELECT count(*) FROM canon_session_queue WHERE epic_id=?1",
            [&epics[2]],
            |r| r.get(0)
        )?,
        1
    );
    drop(db);
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
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    assert_eq!(
        db.query_row::<i64, _, _>(
            "SELECT count(*) FROM canon_session_queue WHERE epic_id=?1",
            [&epics[0]],
            |r| r.get(0)
        )?,
        1
    );
    drop(db);
    script.release();
    s.finish().await?;
    server.abort();
    Ok(())
}
