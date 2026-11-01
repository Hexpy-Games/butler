use super::holds::wait_state;
use super::*;
use butler_e2e::e2e::scenario::Scenario;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

async fn run_plan(s: &Scenario, chat: &str, plan: &str) -> Result<(), HarnessError> {
    data(
        s.gw.post(
            &format!("/sessions/{chat}/canon/queue"),
            json!({"op":"plan_run","plan_id":plan}),
        )
        .await?,
        200,
    );
    Ok(())
}

async fn stop_step(s: &Scenario, chat: &str, epic: &str) -> Result<(), HarnessError> {
    let turn = first_turn(s, chat).await?;
    data(
        s.gw.post(&format!("/turns/{turn}/cancel"), json!({}))
            .await?,
        202,
    );
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let view = data(
            s.gw.get(&format!("/sessions/{chat}/canon/queue")).await?,
            200,
        );
        if view["counts"]["failed"] == 1 {
            return Ok(());
        }
        assert!(Instant::now() < deadline, "{epic} was not held: {view}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// A completed disposition the Work's own evidence does not support holds the
/// step: it must neither advance the queue nor leave the run waiting silently.
async fn refused(
    name: &str,
    style: fn(&crate::canon_link::stub::Script) -> &AtomicBool,
) -> Result<(), HarnessError> {
    let (s, script, server, first, chat) = crate::canon_link::setup(name, false, false).await?;
    let (plan, epics) = plan(&s, &script, &first).await?;
    style(&script).store(true, Ordering::SeqCst);
    script.release();
    run_plan(&s, &chat, &plan).await?;
    let view = wait_state(&s, &chat, &epics[1], "held").await?;
    assert_eq!(view["counts"]["failed"], 1, "{view}");
    assert_eq!(view["counts"]["running"], 0, "{view}");
    let row = data(s.gw.get(&format!("/canon/epics/{}", epics[0])).await?, 200);
    assert_ne!(row["canon_status"], "in_review", "{row}");
    let progress = data(
        s.gw.get(&format!("/canon/epics/{}/progress", epics[0]))
            .await?,
        200,
    );
    assert_eq!(progress["disposition"], "completed", "{progress}");
    assert_ne!(progress["stage"], "reporting", "{progress}");
    assert_eq!(
        script.codes.lock().unwrap().clone(),
        Vec::<String>::new(),
        "BTCC accepted every call"
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn completion_after_rejected_review_holds_the_step() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    refused("CB-GATE-REJECTED", |script| &script.reject_result).await
}

#[tokio::test]
async fn completion_with_nothing_done_holds_the_step() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    refused("CB-GATE-SKIPPED", |script| &script.skip_all).await
}

/// Answering in prose leaves no tool result, and that is still finished work.
#[tokio::test]
async fn prose_only_work_advances() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, first, chat) =
        crate::canon_link::setup("CB-GATE-PROSE", false, false).await?;
    let (plan, _) = plan(&s, &script, &first).await?;
    script.prose_only.store(true, Ordering::SeqCst);
    script.release();
    run_plan(&s, &chat, &plan).await?;
    let view = wait_done(&s, &chat, 3).await?;
    assert_eq!(view["counts"]["failed"], 0, "{view}");
    s.finish().await?;
    server.abort();
    Ok(())
}

/// The Work a stopped step left open must not outlive the run that replaced it.
#[tokio::test]
async fn rerun_after_stop_shows_the_work_that_finished() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, first, chat) =
        crate::canon_link::setup("CB-GATE-RERUN", false, false).await?;
    let (plan, epics) = plan(&s, &script, &first).await?;
    run_plan(&s, &chat, &plan).await?;
    script.wait_held().await;
    stop_step(&s, &chat, &epics[0]).await?;
    script.release();
    data(
        s.gw.post(
            &format!("/sessions/{chat}/canon/queue/holds/{}", epics[0]),
            json!({"decision":"delete"}),
        )
        .await?,
        200,
    );
    wait_done(&s, &chat, 2).await?;
    data(
        s.gw.post(
            &format!("/sessions/{chat}/canon/queue"),
            json!({"op":"start_now","epic_id":epics[0]}),
        )
        .await?,
        200,
    );
    wait_state(&s, &chat, &epics[0], "done").await?;
    let progress = data(
        s.gw.get(&format!("/canon/epics/{}/progress", epics[0]))
            .await?,
        200,
    );
    assert_eq!(progress["disposition"], "completed", "{progress}");
    assert_eq!(progress["stage"], "reporting", "{progress}");
    assert_eq!(progress["running"], json!(false), "{progress}");
    s.finish().await?;
    server.abort();
    Ok(())
}

/// After 그래도 진행 the stopped step's Work stays open, but only the next step runs.
#[tokio::test]
async fn continued_step_is_not_running_with_the_next_one() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, first, chat) =
        crate::canon_link::setup("CB-GATE-CONTINUE", false, false).await?;
    let (plan, epics) = plan(&s, &script, &first).await?;
    run_plan(&s, &chat, &plan).await?;
    script.wait_held().await;
    stop_step(&s, &chat, &epics[0]).await?;
    script.release();
    script.hold_report.store(true, Ordering::SeqCst);
    data(
        s.gw.post(
            &format!("/sessions/{chat}/canon/queue/holds/{}", epics[0]),
            json!({"decision":"continue"}),
        )
        .await?,
        200,
    );
    script.wait_reporting().await;
    let stopped = data(s.gw.get(&format!("/canon/epics/{}", epics[0])).await?, 200);
    assert_eq!(stopped["running"], json!(false), "{stopped}");
    let view = data(
        s.gw.get(&format!("/sessions/{chat}/canon/queue")).await?,
        200,
    );
    assert_eq!(view["counts"]["running"], 1, "{view}");
    script.finish_report();
    wait_done(&s, &chat, 3).await?;
    s.finish().await?;
    server.abort();
    Ok(())
}

/// An offer recorded before it carried the other chat's state must not name a wrong one.
#[tokio::test]
async fn stored_offer_without_state_reads_correctly() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, script, server, first, chat) =
        crate::canon_link::setup("CB-OFFER-STORED", false, false).await?;
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let session: String = db.query_row(
        "SELECT session_id FROM canon_session_epics WHERE epic_id=?1",
        [&first],
        |r| r.get(0),
    )?;
    let payload = json!({"session_id":session,"epic_id":first,"epic_title":"Stored offer","other_session_id":session,"state":"pending"});
    db.execute(
        "INSERT INTO canon_intents(op_id,kind,payload_json,revision,state,created_at) VALUES('canon-take:stored','canon_take_here',?1,0,'pending',0)",
        [payload.to_string()],
    )?;
    drop(db);
    s.restart().await?;
    let app = rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    let deadline = Instant::now() + Duration::from_secs(30);
    let text: String = loop {
        let text = app
            .query_row(
                "SELECT text FROM app_initiated_messages WHERE kind='canon_take_here' AND chat_id=?1",
                [&chat],
                |r| r.get(0),
            )
            .ok();
        if let Some(text) = text {
            break text;
        }
        assert!(Instant::now() < deadline, "the stored offer was not shown");
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    assert!(text.starts_with("‘Stored offer’ is in ‘"), "{text}");
    assert!(text.ends_with("’. Do it here?"), "{text}");
    drop(app);
    drop(script);
    s.finish().await?;
    server.abort();
    Ok(())
}
