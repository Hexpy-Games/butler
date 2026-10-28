use super::*;
use std::sync::atomic::Ordering;

#[tokio::test]
async fn step_turn_without_work_keeps_barrier() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, first, chat) = crate::canon_link::setup("CB-D3", false, false).await?;
    let (plan, epics) = plan(&s, &script, &first).await?;
    script.quick.store(true, Ordering::SeqCst);
    script.release();
    data(
        s.gw.post(
            &format!("/sessions/{chat}/canon/queue"),
            json!({"op":"plan_run","plan_id":plan}),
        )
        .await?,
        200,
    );
    let turn = first_turn(&s, &chat).await?;
    s.gw.wait_terminal(&chat, &turn, std::time::Duration::from_secs(30))
        .await?;
    assert!(
        s.gw.messages(&chat)
            .await?
            .iter()
            .any(|m| m["text"] == "Which evidence should I check?")
    );
    let view = data(
        s.gw.get(&format!("/sessions/{chat}/canon/queue")).await?,
        200,
    );
    assert_eq!(
        view["counts"],
        json!({"running":1,"failed":0,"held":0,"waiting":2})
    );
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    assert_eq!(
        db.query_row::<i64, _, _>(
            "SELECT count(*) FROM canon_intents WHERE kind='canon_step'",
            [],
            |r| r.get(0)
        )?,
        1
    );
    drop(db);
    script.quick.store(false, Ordering::SeqCst);
    s.gw.say(&chat, &format!("Process canon:epic/{} now", epics[0]))
        .await?;
    wait_done(&s, &chat, 3).await?;
    s.finish().await?;
    server.abort();
    Ok(())
}
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
    s.agent.kill9()?;
    s.gw = s.agent.start_again().await?;
    holds::wait_state(&s, &chat, &epics[1], "held").await?;
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    assert_eq!(
        db.query_row::<i64, _, _>(
            "SELECT count(*) FROM canon_intents WHERE kind='canon_hold'",
            [],
            |r| r.get(0)
        )?,
        1
    );
    assert_eq!(
        db.query_row::<i64, _, _>(
            "SELECT count(*) FROM canon_intents WHERE kind='canon_step'",
            [],
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
