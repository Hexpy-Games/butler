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
