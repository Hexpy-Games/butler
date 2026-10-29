use super::*;
use rusqlite::{Connection, params};
use std::time::{Duration, Instant};

#[tokio::test]
async fn failed_session_delete_recovers_on_change_without_restart() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, epic, chat) =
        crate::canon_link::setup("CB-DELETE-REPLAY", false, false).await?;
    let canon = Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let app = Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    app.execute_batch("CREATE TRIGGER reject_panel BEFORE INSERT ON app_initiated_messages WHEN NEW.kind='canon_hold' BEGIN SELECT RAISE(ABORT,'projection unavailable'); END;")?;
    let intent = "delete-pending-panel";
    canon.execute("INSERT INTO canon_intents(op_id,kind,payload_json,state,revision,created_at) VALUES(?1,'canon_hold',?2,'pending',1,0)",params![intent,json!({"session_id":butler_gateway::gateway::app_session_hint(&chat),"epic_id":epic,"epic_title":"Blocked","state":"pending"}).to_string()])?;
    canon.execute_batch("CREATE TRIGGER refuse_delete BEFORE DELETE ON canon_session_epics BEGIN SELECT RAISE(ABORT,'storage unavailable'); END;")?;
    let reply =
        s.gw.delete(&format!("/sessions/{chat}?permanent=true"))
            .await?;
    assert_eq!(reply.status, 500, "{}", reply.text);
    assert_eq!(
        app.query_row::<i64, _, _>("SELECT count(*) FROM chats WHERE id=?1", [&chat], |r| r
            .get(0))?,
        0,
        "App delete committed"
    );
    assert!(
        canon
            .query_row::<i64, _, _>("SELECT count(*) FROM canon_session_epics", [], |r| r.get(0))?
            > 0,
        "canon delete rolled back"
    );
    assert_eq!(
        canon.query_row::<String, _, _>(
            "SELECT state FROM canon_intents WHERE op_id=?1",
            [intent],
            |r| r.get(0)
        )?,
        "pending"
    );
    canon.execute_batch("DROP TRIGGER refuse_delete;")?;
    let row = data(s.gw.get(&format!("/canon/epics/{epic}")).await?, 200);
    data(
        s.gw.patch(
            &format!("/canon/epics/{epic}"),
            json!({"expected_revision":row["revision"],"title":"Changed"}),
        )
        .await?,
        200,
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let bindings: i64 =
            canon.query_row("SELECT count(*) FROM canon_session_epics", [], |r| r.get(0))?;
        let pending: String = canon.query_row(
            "SELECT state FROM canon_intents WHERE op_id=?1",
            [intent],
            |r| r.get(0),
        )?;
        if bindings == 0 && pending == "applied" {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "delete did not recover on real change: bindings={bindings} intent={pending}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let target = data(
        s.gw.post("/sessions", json!({"title":"Next","kind":"chat"}))
            .await?,
        201,
    );
    let target = target["session"]["id"].as_str().unwrap();
    script.release();
    data(
        s.gw.post(
            &format!("/sessions/{target}/canon/queue"),
            json!({"op":"start_now","epic_id":epic}),
        )
        .await?,
        200,
    );
    wait_done(&s, target, 1).await?;
    let turn = first_turn(&s, target).await?;
    s.gw.wait_terminal(target, &turn, Duration::from_secs(30))
        .await?;
    assert_eq!(s.gw.turns(target).await?.len(), 1);
    let before = canon.query_row::<i64, _, _>(
        "SELECT revision FROM canon_intents WHERE op_id=?1",
        [format!("session-delete:{chat}")],
        |r| r.get(0),
    )?;
    // Replay the durable boundary after canon committed but before App removed
    // its outbox receipt: the same delete must be harmless on a second apply.
    app.execute(
        "INSERT INTO app_canon_session_deletes(op_id,session_hint) VALUES(?1,?2)",
        params![
            format!("session-delete:{chat}"),
            butler_gateway::gateway::app_session_hint(&chat)
        ],
    )?;
    let row = data(s.gw.get(&format!("/canon/epics/{epic}")).await?, 200);
    data(
        s.gw.patch(
            &format!("/canon/epics/{epic}"),
            json!({"expected_revision":row["revision"],"title":"Changed again"}),
        )
        .await?,
        200,
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    while app.query_row::<bool, _, _>(
        "SELECT EXISTS(SELECT 1 FROM app_canon_session_deletes WHERE op_id=?1)",
        [format!("session-delete:{chat}")],
        |r| r.get(0),
    )? {
        assert!(
            Instant::now() < deadline,
            "delete receipt was not consumed twice"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(
        canon.query_row::<i64, _, _>(
            "SELECT revision FROM canon_intents WHERE op_id=?1",
            [format!("session-delete:{chat}")],
            |r| r.get(0)
        )?,
        before
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn failed_delete_is_replayed_before_first_start_in_another_chat() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let (s, script, server, first, source) =
        crate::canon_link::setup("CB-DELETE-FIRST-START", false, false).await?;
    let (plan, epics) = plan(&s, &script, &first).await?;
    let epic = &epics[1];
    script.epics.lock().unwrap().swap(0, 1);
    let app = Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    let canon = Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let target = data(
        s.gw.post("/sessions", json!({"title":"Target","kind":"chat"}))
            .await?,
        201,
    );
    let target = target["session"]["id"].as_str().unwrap();
    // Leave a real source queue row before admission, without a running turn.
    app.execute_batch("CREATE TRIGGER hold_step AFTER INSERT ON app_initiated_messages WHEN NEW.kind='canon_step' BEGIN UPDATE app_initiated_messages SET posting=1 WHERE id=NEW.id; END;")?;
    data(
        s.gw.post(
            &format!("/sessions/{source}/canon/queue"),
            json!({"op":"plan_run","plan_id":plan}),
        )
        .await?,
        200,
    );
    canon.execute_batch("CREATE TRIGGER refuse_delete BEFORE DELETE ON canon_session_queue BEGIN SELECT RAISE(ABORT,'storage unavailable'); END;")?;
    let deleted =
        s.gw.delete(&format!("/sessions/{source}?permanent=true"))
            .await?;
    assert_eq!(deleted.status, 500, "{}", deleted.text);
    assert_eq!(
        app.query_row::<i64, _, _>("SELECT count(*) FROM chats WHERE id=?1", [&source], |r| r
            .get(0))?,
        0
    );
    assert_eq!(canon.query_row::<i64,_,_>("SELECT count(*) FROM canon_session_queue WHERE session_id=?1 AND epic_id=?2 AND state='waiting'", params![butler_gateway::gateway::app_session_hint(&source), epic], |r| r.get(0))?, 1);
    // Drain the startup/preceding queue changes while deletion still fails.
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let before = (db_version(&canon)?, db_version(&app)?);
        tokio::time::sleep(Duration::from_secs(1)).await;
        if before == (db_version(&canon)?, db_version(&app)?) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "delete failure never became idle"
        );
    }
    // Removing failure injection makes no canon change and cannot wake replay.
    canon.execute_batch("DROP TRIGGER refuse_delete;")?;
    app.execute_batch("DROP TRIGGER hold_step;")?;
    assert_eq!(
        canon.query_row::<String, _, _>(
            "SELECT state FROM canon_session_queue WHERE session_id=?1 AND epic_id=?2",
            params![butler_gateway::gateway::app_session_hint(&source), epic],
            |r| r.get(0)
        )?,
        "waiting"
    );
    script.release();
    let started = data(
        s.gw.post(
            &format!("/sessions/{target}/canon/queue"),
            json!({"op":"start_now","epic_id":epic}),
        )
        .await?,
        200,
    );
    assert_ne!(started["code"], "held_elsewhere", "{started}");
    wait_done(&s, target, 1).await?;
    let turn = first_turn(&s, target).await?;
    s.gw.wait_terminal(target, &turn, Duration::from_secs(30))
        .await?;
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
        canon.query_row::<i64, _, _>(
            "SELECT count(*) FROM canon_intents WHERE kind='canon_take_here'",
            [],
            |r| r.get(0)
        )?,
        0
    );
    assert_eq!(
        app.query_row::<i64, _, _>(
            "SELECT count(*) FROM app_initiated_messages WHERE kind='canon_take_here'",
            [],
            |r| r.get(0)
        )?,
        0
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

fn db_version(db: &Connection) -> rusqlite::Result<i64> {
    db.query_row("PRAGMA data_version", [], |r| r.get(0))
}
