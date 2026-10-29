use super::*;
use butler_e2e::e2e::scenario::Scenario;
use rusqlite::{Connection, params};
use std::time::{Duration, Instant};

#[tokio::test]
async fn persistent_replay_error_waits_for_real_change() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, _, server, epic, chat) =
        crate::canon_link::setup("CB-REPLAY-ERROR", false, false).await?;
    data(
        s.gw.patch("/settings", json!({"diagnostics_enabled":true}))
            .await?,
        200,
    );
    s.agent.terminate().await?;
    let canon = Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let app = Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    // A real persistent storage failure at the panel projection boundary.
    app.execute_batch("CREATE TRIGGER reject_panel BEFORE INSERT ON app_initiated_messages WHEN NEW.kind='canon_hold' BEGIN SELECT RAISE(ABORT,'storage unavailable'); END;")?;
    canon.execute("INSERT INTO canon_intents(op_id,kind,payload_json,state,revision,created_at) VALUES(?1,'canon_hold',?2,'pending',1,0)", params![uuid::Uuid::new_v4().to_string(), json!({"session_id":butler_gateway::gateway::app_session_hint(&chat),"epic_id":epic,"epic_title":"Blocked","state":"pending"}).to_string()])?;
    // A publication acknowledgement is another real BTCC write. Hold the
    // existing relay barrier so this test sends exactly one change at a time.
    let relay_release = s.sandbox.data.join("relay-release");
    s.agent
        .launch
        .set_env("BUTLER_E2E_HOLD_POINT", "canon_relay_start");
    s.agent
        .launch
        .set_env("BUTLER_E2E_HOLD_RELEASE", relay_release.to_string_lossy());
    s.gw = s.agent.start_again().await?;
    let deadline = Instant::now() + Duration::from_secs(10);
    while failures(&s).await? == 0 {
        assert!(
            Instant::now() < deadline,
            "replay never attempted projection"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let before = failures(&s).await?;
    tokio::time::sleep(Duration::from_secs(1)).await;
    let idle = failures(&s).await?;
    eprintln!("REPLAY-ERROR idle failures: {before} -> {idle}");
    assert_eq!(before, 1, "one initial replay");
    assert_eq!(idle, before, "an error must not wake its own replay");
    let row = data(s.gw.get(&format!("/canon/epics/{epic}")).await?, 200);
    data(
        s.gw.patch(
            &format!("/canon/epics/{epic}"),
            json!({"expected_revision":row["revision"],"title":"Changed"}),
        )
        .await?,
        200,
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    while failures(&s).await? == idle {
        assert!(
            Instant::now() < deadline,
            "real change did not retry replay"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    tokio::time::sleep(Duration::from_secs(1)).await;
    let after = failures(&s).await?;
    eprintln!("REPLAY-ERROR one change: {idle} -> {after}");
    assert_eq!(after, idle + 1, "one replay per real change");
    std::fs::write(relay_release, b"continue")?;
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn take_deleted_source_resolves_and_runs_target_once() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, epic, source) =
        crate::canon_link::setup("CB-TAKE-DELETED", false, false).await?;
    let app = Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    let canon = Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    // Keep the source before admission, then refuse its terminal canon receipt.
    app.execute_batch(&format!("CREATE TRIGGER hold_step AFTER INSERT ON app_initiated_messages WHEN NEW.kind='canon_step' AND NEW.chat_id='{source}' BEGIN UPDATE app_initiated_messages SET posting=1 WHERE id=NEW.id; END;"))?;
    app.execute_batch("CREATE TRIGGER refuse_offer BEFORE INSERT ON app_initiated_messages WHEN NEW.kind='canon_take_here' BEGIN SELECT RAISE(ABORT,'projection unavailable'); END;")?;
    canon.execute_batch("CREATE TRIGGER refuse_receipt BEFORE DELETE ON canon_step_cancellations BEGIN SELECT RAISE(ABORT,'receipt unavailable'); END;")?;
    data(
        s.gw.post(
            &format!("/sessions/{source}/canon/queue"),
            json!({"op":"start_now","epic_id":epic}),
        )
        .await?,
        200,
    );
    let target = data(
        s.gw.post("/sessions", json!({"title":"Target","kind":"chat"}))
            .await?,
        201,
    );
    let target = target["session"]["id"].as_str().unwrap();
    data(
        s.gw.post(
            &format!("/sessions/{target}/canon/queue"),
            json!({"op":"start_now","epic_id":epic}),
        )
        .await?,
        200,
    );
    data(
        s.gw.post(
            &format!("/sessions/{target}/canon/queue/take/{epic}"),
            json!({}),
        )
        .await?,
        200,
    );
    assert_eq!(s.gw.turns(&source).await?.len(), 0);
    assert_eq!(s.gw.turns(target).await?.len(), 0);
    data(
        s.gw.patch("/settings", json!({"diagnostics_enabled":true}))
            .await?,
        200,
    );
    let deleted =
        s.gw.delete(&format!("/sessions/{source}?permanent=true"))
            .await?;
    assert_eq!(
        deleted.status, 500,
        "canon receipt fails after App delete: {}",
        deleted.text
    );
    assert_eq!(
        app.query_row::<i64, _, _>("SELECT count(*) FROM chats WHERE id=?1", [&source], |r| r
            .get(0))?,
        0
    );
    assert_eq!(
        canon.query_row::<i64, _, _>("SELECT count(*) FROM canon_step_cancellations", [], |r| r
            .get(0))?,
        1
    );
    let independent = "independent-panel";
    canon.execute("INSERT INTO canon_intents(op_id,kind,payload_json,state,revision,created_at) VALUES(?1,'canon_hold',?2,'pending',1,0)", params![independent,json!({"session_id":butler_gateway::gateway::app_session_hint(target),"epic_id":epic,"epic_title":"Independent","state":"pending"}).to_string()])?;
    let row = data(s.gw.get(&format!("/canon/epics/{epic}")).await?, 200);
    data(
        s.gw.patch(
            &format!("/canon/epics/{epic}"),
            json!({"expected_revision":row["revision"],"title":"Wake independent op"}),
        )
        .await?,
        200,
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    while canon.query_row::<String, _, _>(
        "SELECT state FROM canon_intents WHERE op_id=?1",
        [independent],
        |r| r.get(0),
    )? != "applied"
    {
        assert!(
            Instant::now() < deadline,
            "failed deleted-source receipt hid another pending op"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    canon.execute_batch("DROP TRIGGER refuse_receipt;")?;
    app.execute_batch("DROP TRIGGER hold_step; DROP TRIGGER refuse_offer;")?;
    script.release();
    let row = data(s.gw.get(&format!("/canon/epics/{epic}")).await?, 200);
    data(
        s.gw.patch(
            &format!("/canon/epics/{epic}"),
            json!({"expected_revision":row["revision"],"title":"Wake recovery"}),
        )
        .await?,
        200,
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let pending: i64 = canon.query_row(
            "SELECT count(*) FROM canon_intents WHERE kind='canon_take_here' AND state='pending'",
            [],
            |r| r.get(0),
        )?;
        if pending == 0 {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "deleted-source intents remain pending"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    wait_done(&s, target, 1).await?;
    let turn = first_turn(&s, target).await?;
    s.gw.wait_terminal(target, &turn, Duration::from_secs(30))
        .await?;
    assert!(log_count(&s, "Canon%20source%20cancellation%20remains%20pending").await? > 0);
    tokio::time::sleep(Duration::from_millis(250)).await;
    let before = (version(&canon)?, version(&app)?);
    tokio::time::sleep(Duration::from_secs(1)).await;
    let after = (version(&canon)?, version(&app)?);
    eprintln!("DELETED-SOURCE idle database versions: {before:?} -> {after:?}");
    assert_eq!(after, before);
    assert_eq!(s.gw.turns(target).await?.len(), 1);
    assert_eq!(
        s.gw.messages(target)
            .await?
            .iter()
            .filter(|m| m["initiated"]["kind"] == "canon_step")
            .count(),
        1
    );
    assert_eq!(
        canon.query_row::<i64, _, _>("SELECT count(*) FROM canon_step_cancellations", [], |r| r
            .get(0))?,
        0
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

async fn failures(s: &Scenario) -> Result<usize, HarnessError> {
    Ok(
        log_count(s, "Canon%20conversation%20replay%20failed").await?
            + log_count(s, "Canon%20queue%20intent%20failed").await?,
    )
}

async fn log_count(s: &Scenario, query: &str) -> Result<usize, HarnessError> {
    let page = data(s.gw.get(&format!("/logs?q={query}&limit=1000")).await?, 200);
    assert!(
        page["cursor"].is_null(),
        "replay log count exceeds one page"
    );
    Ok(page["rows"].as_array().unwrap().len())
}

fn version(db: &Connection) -> rusqlite::Result<i64> {
    db.query_row("PRAGMA data_version", [], |r| r.get(0))
}
