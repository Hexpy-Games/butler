use super::*;
use std::time::{Duration, Instant};

#[tokio::test]
async fn take_restart_with_pending_source_step_never_duplicates() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, script, server, epic, source) =
        crate::canon_link::setup("CB-TAKE-RECOVERY", false, false).await?;
    let target = data(
        s.gw.post("/sessions", json!({"title":"Target","kind":"chat"}))
            .await?,
        201,
    );
    let target = target["session"]["id"].as_str().unwrap().to_owned();
    let app_path = s.sandbox.data.join("app-server/butler-client.sqlite");
    {
        let db = rusqlite::Connection::open(&app_path)?;
        // Hold the source delivery claim using the existing durable outbox surface.
        db.execute_batch(&format!("CREATE TRIGGER hold_source_step AFTER INSERT ON app_initiated_messages WHEN NEW.kind='canon_step' AND NEW.chat_id='{source}' BEGIN UPDATE app_initiated_messages SET posting=1 WHERE id=NEW.id; END;"))?;
    }
    data(
        s.gw.post(
            &format!("/sessions/{source}/canon/queue"),
            json!({"op":"start_now","epic_id":epic}),
        )
        .await?,
        200,
    );
    let deadline = Instant::now() + Duration::from_secs(30);
    let source_id = loop {
        let db = rusqlite::Connection::open(&app_path)?;
        let ids = db
            .prepare(
                "SELECT id FROM app_initiated_messages WHERE kind='canon_step' AND chat_id=?1",
            )?
            .query_map([&source], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        if let Some(id) = ids.first() {
            break id.clone();
        }
        assert!(Instant::now() < deadline, "source intent was not projected");
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    script
        .quick
        .store(true, std::sync::atomic::Ordering::SeqCst);
    script.release();
    data(
        s.gw.post(
            &format!("/sessions/{target}/canon/queue/take/{epic}"),
            json!({}),
        )
        .await?,
        200,
    );
    let turn = first_turn(&s, &target).await?;
    s.gw.wait_terminal(&target, &turn, Duration::from_secs(30))
        .await?;
    s.agent.kill9()?;
    {
        let canon = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
        let owner: String = canon.query_row(
            "SELECT session_id FROM canon_session_queue WHERE epic_id=?1",
            [&epic],
            |r| r.get(0),
        )?;
        assert_eq!(owner, butler_gateway::gateway::app_session_hint(&target));
        let db = rusqlite::Connection::open(&app_path)?;
        // Recreate the exact crash window: the canon move committed, but the
        // source's held intent has not yet been withdrawn. It has no turn/message.
        assert_eq!(db.execute("UPDATE app_initiated_messages SET state='held',posting=0 WHERE id=?1 AND state='withdrawn'", [&source_id])?, 1);
        let messages: i64 = db.query_row(
            "SELECT count(*) FROM messages WHERE chat_id=?1",
            [&source],
            |r| r.get(0),
        )?;
        assert_eq!(messages, 0);
        db.execute_batch("DROP TRIGGER hold_source_step")?;
    }
    s.gw = s.agent.start_again().await?;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let db = rusqlite::Connection::open(&app_path)?;
        let state: String = db.query_row(
            "SELECT state FROM app_initiated_messages WHERE id=?1",
            [&source_id],
            |r| r.get(0),
        )?;
        if state == "withdrawn" {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "stale source intent was not withdrawn: {state}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(
        s.gw.messages(&source)
            .await?
            .iter()
            .all(|m| m["initiated"]["kind"] != "canon_step")
    );
    assert_eq!(
        s.gw.messages(&target)
            .await?
            .iter()
            .filter(|m| m["initiated"]["kind"] == "canon_step")
            .count(),
        1
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn take_failed_cancel_is_durable_and_never_runs_twice() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, epic, source) =
        crate::canon_link::setup("CB-TAKE-CANCEL", false, false).await?;
    data(
        s.gw.post(
            &format!("/sessions/{source}/canon/queue"),
            json!({"op":"start_now","epic_id":epic}),
        )
        .await?,
        200,
    );
    script.wait_held().await;
    let source_turn = first_turn(&s, &source).await?;
    let target = data(
        s.gw.post("/sessions", json!({"title":"Target","kind":"chat"}))
            .await?,
        201,
    );
    let target = target["session"]["id"].as_str().unwrap();
    let app = rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    // A storage failure before the cancel outbox commits is reachable while the
    // native turn remains alive. Exercise that boundary without a product hook.
    app.execute_batch("CREATE TRIGGER refuse_cancel BEFORE UPDATE OF state ON turns WHEN NEW.state='cancelling' BEGIN SELECT RAISE(ABORT,'cancel storage unavailable'); END;")?;
    let moved = data(
        s.gw.post(
            &format!("/sessions/{target}/canon/queue/take/{epic}"),
            json!({}),
        )
        .await?,
        200,
    );
    assert_eq!(moved["chains"][0]["steps"][0]["items"][0]["epic_id"], epic);
    let canon = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let pending = || {
        canon.query_row::<i64, _, _>(
            "SELECT count(*) FROM canon_step_cancellations WHERE epic_id=?1",
            [&epic],
            |r| r.get(0),
        )
    };
    assert_eq!(pending()?, 1);
    let state: String =
        app.query_row("SELECT state FROM turns WHERE id=?1", [&source_turn], |r| {
            r.get(0)
        })?;
    assert_eq!(state, "thinking");
    assert!(
        s.gw.turns(target).await?.is_empty(),
        "target ran before source stopped"
    );
    app.execute_batch("DROP TRIGGER refuse_cancel")?;
    script
        .quick
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let wake = data(
        s.gw.post("/sessions", json!({"title":"Other","kind":"chat"}))
            .await?,
        201,
    );
    let wake = wake["session"]["id"].as_str().unwrap();
    // An unrelated turn ends; its existing native change notification retries
    // the indexed cancellation, without a restart, timer or manual Stop.
    let wake_turn = s.gw.say_turn(wake, "What does this mean?").await?;
    s.gw.wait_terminal(wake, &wake_turn, Duration::from_secs(30))
        .await?;
    let source_result =
        s.gw.wait_terminal(&source, &source_turn, Duration::from_secs(30))
            .await?;
    assert_eq!(source_result["state"], "cancelled");
    let target_turn = first_turn(&s, target).await?;
    s.gw.wait_terminal(target, &target_turn, Duration::from_secs(30))
        .await?;
    assert_eq!(pending()?, 0);
    assert_eq!(s.gw.turns(&source).await?.len(), 1);
    assert_eq!(s.gw.turns(target).await?.len(), 1);
    assert_eq!(
        s.gw.messages(target)
            .await?
            .iter()
            .filter(|m| m["initiated"]["kind"] == "canon_step")
            .count(),
        1
    );
    script.release();
    s.finish().await?;
    server.abort();
    Ok(())
}
