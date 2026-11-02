use super::*;
use std::time::{Duration, Instant};

#[tokio::test]
async fn canon_queue_remove_preserves_hold_text_through_replay() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    settled_hold(false).await
}

#[tokio::test]
async fn canon_queue_take_preserves_source_hold_text_through_replay() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    settled_hold(true).await
}

async fn settled_hold(take: bool) -> Result<(), HarnessError> {
    let (mut s, script, server, first, chat) =
        crate::canon_link::setup("QUEUE-PANEL-HISTORY", false, false).await?;
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
    holds::wait_state(&s, &chat, &epics[2], "held").await?;
    let app = rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    let deadline = Instant::now() + Duration::from_secs(30);
    let (source, original) = loop {
        let row = app.query_row("SELECT source_key,text FROM app_initiated_messages WHERE kind='canon_hold' AND state='posted'", [], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)));
        if let Ok(row) = row {
            break row;
        }
        assert!(Instant::now() < deadline, "hold panel was not posted");
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    if take {
        let other = data(
            s.gw.post(
                "/sessions",
                json!({"title":"Another conversation","kind":"chat"}),
            )
            .await?,
            201,
        );
        let target = other["session"]["id"].as_str().unwrap();
        data(
            s.gw.post(
                &format!("/sessions/{target}/canon/queue/take/{}", epics[1]),
                json!({}),
            )
            .await?,
            200,
        );
    } else {
        data(
            s.gw.post(
                &format!("/sessions/{chat}/canon/queue/holds/{}", epics[1]),
                json!({"decision":"delete"}),
            )
            .await?,
            200,
        );
    }
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let state: String = app.query_row("SELECT json_extract(payload_json,'$.panel.state') FROM app_initiated_messages WHERE source_key=?1",[&source],|r|r.get(0))?;
        if state == "deleted" {
            break;
        }
        assert!(Instant::now() < deadline, "hold decision was not projected");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_text(&app, &source, &original)?;
    assert_eq!(
        s.gw.get(&format!("/canon/epics/{}", epics[1]))
            .await?
            .status,
        200
    );
    s.agent.terminate().await?;
    let canon = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    canon.execute("UPDATE canon_intents SET state='pending' WHERE json_extract(payload_json,'$.source_key')=?1",[&source])?;
    s.gw = s.agent.start_again().await?;
    let deadline = Instant::now() + Duration::from_secs(30);
    while canon.query_row::<i64,_,_>("SELECT count(*) FROM canon_intents WHERE state='pending' AND json_extract(payload_json,'$.source_key')=?1",[&source],|r|r.get(0))? > 0 {
        assert!(Instant::now() < deadline,"decision replay did not settle");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_text(&app, &source, &original)?;
    s.finish().await?;
    server.abort();
    Ok(())
}

fn assert_text(
    app: &rusqlite::Connection,
    source: &str,
    original: &str,
) -> Result<(), HarnessError> {
    let (text, message): (String, Option<String>) = app.query_row(
        "SELECT text,message_id FROM app_initiated_messages WHERE source_key=?1",
        [source],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    assert_eq!(text, original, "queue decisions must preserve hold history");
    let message = message.unwrap();
    assert_eq!(
        app.query_row::<String, _, _>("SELECT text FROM messages WHERE id=?1", [&message], |r| r
            .get(0))?,
        original
    );
    assert_eq!(
        app.query_row::<String, _, _>(
            "SELECT f.text FROM messages_fts f JOIN messages m ON m.rowid=f.rowid WHERE m.id=?1",
            [&message],
            |r| r.get(0)
        )?,
        original
    );
    Ok(())
}
