//! A held step whose message never started a Turn stays deletable after archive.
use super::*;
use crate::canon_plan_run::{fixture, unfinished};
use std::time::Instant;

async fn archived_queued_step(restart_before: bool) -> Result<(), HarnessError> {
    let (mut s, script, server, first, chat) =
        crate::canon_link::setup("EPIC-DELETE-ARCHIVED-QUEUED", false, false).await?;
    let (plan, epics) = fixture::plan(&s, &script, &first).await?;
    unfinished::run_plan(&s, &chat, &plan).await?;
    script.wait_held().await;
    let second = &epics[1];
    let view = data(
        s.gw.get(&format!("/sessions/{chat}/canon/queue")).await?,
        200,
    );
    data(s.gw.post(&format!("/sessions/{chat}/canon/queue/edits"), json!({"expected_graph_revision":view["graph_revision"],"op":"join_stack","epic_id":second,"target_epic_id":first})).await?, 200);
    let app =
        butler_platform::sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    let canon = db(&s)?;
    let op: String = canon.query_row("SELECT step_op_id FROM canon_session_queue WHERE epic_id=?1 AND state='running' AND hold_reason IS NULL AND turn_ended_at IS NULL", [second], |r|r.get(0))?;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let queued: bool = app.query_row("SELECT EXISTS(SELECT 1 FROM app_initiated_messages i JOIN session_queued_messages q ON q.client_message_id=i.message_id AND q.chat_id=i.chat_id WHERE i.source_key=?1 AND NOT EXISTS(SELECT 1 FROM turns t WHERE t.user_message_id=i.message_id))", [&op], |r|r.get(0))?;
        if queued {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "second step never queued behind the first"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    data(
        s.gw.post(&format!("/sessions/{chat}/archive"), json!({}))
            .await?,
        200,
    );
    crate::canon_plan_run::stop_paths::wait_nothing_runs(&s).await?;
    script.release();
    unfinished::wait_card(&s, "pending").await?;
    if restart_before {
        s.restart().await?;
    }
    let source: String = canon.query_row("SELECT question_message_id FROM canon_session_queue WHERE epic_id=?1 AND hold_reason='cancelled' AND turn_ended_at IS NULL", [second], |r|r.get(0))?;
    assert_eq!(app.query_row::<i64,_,_>("SELECT count(*) FROM turns t JOIN app_initiated_messages i ON i.message_id=t.user_message_id WHERE i.source_key=?1", [&op], |r|r.get(0))?, 0);
    let epic = data(s.gw.get(&format!("/canon/epics/{second}")).await?, 200);
    let reply = delete(&s, &epic, &epic["revision"]).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    assert_eq!(epic["delete_blocked"], false, "{epic}");
    panels::wait_settled(&app, &source).await?;
    assert_settled(&s, &app, second, &source).await?;
    s.restart().await?;
    assert_settled(&s, &app, second, &source).await?;
    drop(canon);
    drop(app);
    s.finish().await?;
    server.abort();
    Ok(())
}

async fn assert_settled(
    s: &Scenario,
    app: &rusqlite::Connection,
    epic: &str,
    source: &str,
) -> Result<(), HarnessError> {
    assert_eq!(s.gw.get(&format!("/canon/epics/{epic}")).await?.status, 404);
    let canon = db(s)?;
    assert_eq!(count(&canon, "canon_session_queue", epic), 0);
    assert_eq!(app.query_row::<String,_,_>("SELECT json_extract(payload_json,'$.panel.state') FROM app_initiated_messages WHERE source_key=?1", [source], |r|r.get(0))?, "deleted");
    Ok(())
}

#[tokio::test]
async fn epic_delete_archived_queued_step() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    archived_queued_step(false).await
}

#[tokio::test]
async fn epic_delete_archived_queued_step_after_restart() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    archived_queued_step(true).await
}
