use super::*;
use std::sync::atomic::Ordering;

#[tokio::test]
async fn plan_run_restart_active_step_with_queued_steps() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, script, server, first, chat) =
        crate::canon_link::setup("CB-RESTART", false, false).await?;
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
    for _ in 0..2 {
        s.agent.kill9()?;
        s.gw = s.agent.start_again().await?;
        holds::wait_state(&s, &chat, &epics[1], "held").await?;
        let view = holds::wait_state(&s, &chat, &epics[2], "held").await?;
        assert_eq!(view["counts"]["failed"], 1);
        let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
        let reason: String = db.query_row(
            "SELECT hold_reason FROM canon_session_queue WHERE epic_id=?1",
            [&epics[0]],
            |r| r.get(0),
        )?;
        assert_eq!(reason, "turn_interrupted");
        drop(db);
        let app =
            rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            let cards: i64 = app.query_row("SELECT count(*) FROM app_initiated_messages WHERE chat_id=?1 AND kind='canon_hold'", [&chat], |r|r.get(0))?;
            if cards == 1 {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "expected exactly one hold card, got {cards}"
            );
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        let (state, code): (String,String) = app.query_row("SELECT t.state,t.safe_error_code FROM turns t JOIN app_initiated_messages i ON i.message_id=t.user_message_id WHERE i.chat_id=?1 AND json_extract(i.payload_json,'$.epic_id')=?2", rusqlite::params![chat,epics[0]], |r|Ok((r.get(0)?,r.get(1)?)))?;
        assert_eq!(
            (state.as_str(), code.as_str()),
            ("failed", "turn_interrupted")
        );
        let messages: i64 = app.query_row("SELECT count(*) FROM messages m WHERE m.chat_id=?1 AND (EXISTS(SELECT 1 FROM app_initiated_messages i WHERE i.message_id=m.id AND i.kind='canon_step' AND json_extract(i.payload_json,'$.epic_id')=?2) AND NOT EXISTS(SELECT 1 FROM messages a WHERE a.turn_id=m.turn_id AND a.role='assistant') OR EXISTS(SELECT 1 FROM turns t JOIN app_initiated_messages i ON i.message_id=t.user_message_id WHERE m.turn_id=t.id AND m.role='assistant' AND i.kind='canon_step' AND json_extract(i.payload_json,'$.epic_id')=?2))", rusqlite::params![chat,epics[0]], |r|r.get(0))?;
        assert_eq!(
            messages, 1,
            "count actual initiated or rendered chat messages"
        );
    }
    script.release();
    s.finish().await?;
    server.abort();
    Ok(())
}
