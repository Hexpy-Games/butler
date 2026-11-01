//! Real unfinished-step cards settle when their 과제 is deleted, including in that chat.
use super::*;
use crate::canon_plan_run::{fixture, unfinished};
use std::sync::atomic::Ordering;

async fn held_delete(chat_approval: bool, last: bool) -> Result<(), HarnessError> {
    let (mut s, script, server, first, chat) =
        crate::canon_link::setup("EPIC-DELETE-UNFINISHED", false, false).await?;
    let (plan, epics) = fixture::plan(&s, &script, &first).await?;
    if last {
        for id in &epics[1..] {
            let epic = data(s.gw.get(&format!("/canon/epics/{id}")).await?, 200);
            data(
                s.gw.patch(
                    &format!("/canon/epics/{id}"),
                    json!({"expected_revision":epic["revision"],"status":"done"}),
                )
                .await?,
                200,
            );
        }
    }
    script.quick.store(true, Ordering::SeqCst);
    script.release();
    unfinished::run_plan(&s, &chat, &plan).await?;
    assert_eq!(unfinished::wait_card(&s, "pending").await?.len(), 1);
    let canon = db(&s)?;
    let (source, reason): (String, String) = canon.query_row(
        "SELECT question_message_id,hold_reason FROM canon_session_queue WHERE epic_id=?1",
        [&first],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    assert_eq!(reason, "step_unfinished");
    assert_eq!(count(&canon, "canon_epic_work_links", &first), 0);
    let epic = data(s.gw.get(&format!("/canon/epics/{first}")).await?, 200);
    // A held step's chat may be answering a question or proposing its deletion.
    // That live Turn must not make every bound step run again.
    script.hold_report.store(true, Ordering::SeqCst);
    if chat_approval {
        script.calls.lock().unwrap().insert(
            "Delete the held task".into(),
            vec![(
                "canon_propose",
                args(epic["project_id"].as_str().unwrap(), &epic),
            )],
        );
    }
    let accepted =
        s.gw.say(
            &chat,
            if chat_approval {
                "Delete the held task"
            } else {
                "What does this mean?"
            },
        )
        .await?;
    let turn = s.gw.accepted_turn(&accepted).await?;
    script.wait_reporting().await;
    script.quick.store(false, Ordering::SeqCst);
    if chat_approval {
        let page = asks(&s, &chat).await?;
        assert_eq!(
            page["open_count"],
            1,
            "{page}; codes: {:?}",
            script.codes.lock().unwrap()
        );
        let id = page["asks"][0]["ask_id"]
            .as_str()
            .unwrap()
            .trim_start_matches("canon:");
        assert_eq!(accept(&s, id).await?["ok"], true);
    } else {
        let reply = delete(&s, &epic, &epic["revision"]).await?;
        assert_eq!(reply.status, 200, "{}", reply.text);
    }
    script.finish_report();
    s.gw.wait_terminal(&chat, &turn, Duration::from_secs(30))
        .await?;
    fixture::wait_done(&s, &chat, if last { 0 } else { 2 }).await?;
    let app =
        butler_platform::sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    panels::wait_settled(&app, &source).await?;
    assert_deleted(&s, &chat, &first, &source).await?;
    drop(app);
    drop(canon);
    s.restart().await?;
    assert_deleted(&s, &chat, &first, &source).await?;
    fixture::wait_done(&s, &chat, if last { 0 } else { 2 }).await?;
    s.finish().await?;
    server.abort();
    Ok(())
}

async fn assert_deleted(
    s: &Scenario,
    chat: &str,
    epic: &str,
    source: &str,
) -> Result<(), HarnessError> {
    let canon = db(s)?;
    for table in [
        "canon_session_queue",
        "canon_session_epics",
        "canon_step_cancellations",
    ] {
        assert_eq!(count(&canon, table, epic), 0, "{table}");
    }
    assert_eq!(
        canon.query_row::<i64, _, _>(
            "SELECT count(*) FROM canon_session_queue WHERE held_by_epic_id=?1",
            [epic],
            |r| r.get(0)
        )?,
        0
    );
    assert_eq!(canon.query_row::<i64,_,_>("SELECT count(*) FROM canon_intents WHERE json_extract(payload_json,'$.epic_id')=?1 AND (kind='canon_step' OR json_extract(payload_json,'$.state')='pending')", [epic], |r|r.get(0))?, 0);
    let app =
        butler_platform::sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    assert_eq!(app.query_row::<String,_,_>("SELECT json_extract(payload_json,'$.panel.state') FROM app_initiated_messages WHERE source_key=?1", [source], |r|r.get(0))?, "deleted");
    let view = data(
        s.gw.get(&format!("/sessions/{chat}/canon/queue")).await?,
        200,
    );
    assert_eq!(
        view["counts"],
        json!({"running":0,"failed":0,"held":0,"waiting":0})
    );
    assert!(!view.to_string().contains(epic), "{view}");
    let messages = s.gw.messages(chat).await?;
    let card = messages
        .iter()
        .find(|m| {
            m["initiated"]["panel"]["epic_id"] == epic && m["initiated"]["kind"] == "canon_hold"
        })
        .expect("posted hold card");
    assert_eq!(card["initiated"]["panel"]["state"], "deleted");
    assert_eq!(s.gw.get(&format!("/canon/epics/{epic}")).await?.status, 404);
    Ok(())
}

#[tokio::test]
async fn epic_delete_unfinished_http_continues_after_restart() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    held_delete(false, false).await
}
#[tokio::test]
async fn epic_delete_unfinished_chat_continues_after_restart() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    held_delete(true, false).await
}
#[tokio::test]
async fn epic_delete_unfinished_http_last_step_stays_idle_after_restart() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    held_delete(false, true).await
}
#[tokio::test]
async fn epic_delete_unfinished_chat_last_step_stays_idle_after_restart() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    held_delete(true, true).await
}

/// Stop leaves the actual Work open; no reopening or link timestamp edits.
pub(super) async fn stopped_work(
    s: &Scenario,
    script: &crate::canon_link::stub::Script,
    epic: &str,
    chat: &str,
) -> Result<(), HarnessError> {
    let accepted =
        s.gw.say(chat, &format!("Process canon:epic/{epic} now"))
            .await?;
    let turn = s.gw.accepted_turn(&accepted).await?;
    script.wait_held().await;
    data(
        s.gw.post(&format!("/turns/{turn}/cancel"), json!({}))
            .await?,
        202,
    );
    s.gw.wait_terminal(chat, &turn, Duration::from_secs(30))
        .await?;
    let canon = db(s)?;
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    loop {
        let state: String = canon.query_row(
            "SELECT semantic_state FROM btcc_turns WHERE turn_id=?1",
            [&turn],
            |r| r.get(0),
        )?;
        if state == "cancelled" {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "Stop has not settled: {state}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    script.release();
    assert_eq!(canon.query_row::<String,_,_>("SELECT w.status FROM canon_epic_work_links l JOIN btcc_guided_works w ON w.work_id=l.btcc_work_id WHERE l.epic_id=?1", [epic], |r| r.get(0))?, "open");
    Ok(())
}

#[tokio::test]
async fn epic_delete_review_unfinished_linked_work_blocks_reply_then_settles()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, first, chat) =
        crate::canon_link::setup("EPIC-DELETE-LINKED-REPLY", false, false).await?;
    stopped_work(&s, &script, &first, &chat).await?;
    script.quick.store(true, Ordering::SeqCst);
    data(
        s.gw.post(
            &format!("/sessions/{chat}/canon/queue"),
            json!({"op":"start_now","epic_id":first}),
        )
        .await?,
        200,
    );
    unfinished::wait_card(&s, "pending").await?;
    let canon = db(&s)?;
    let (source, reason): (String, String) = canon.query_row(
        "SELECT question_message_id,hold_reason FROM canon_session_queue WHERE epic_id=?1 AND turn_ended_at IS NOT NULL AND decision IS NULL",
        [&first], |r| Ok((r.get(0)?,r.get(1)?)))?;
    assert_eq!(reason, "step_unfinished");
    assert_eq!(count(&canon, "canon_epic_work_links", &first), 1);
    script.hold_report.store(true, Ordering::SeqCst);
    let accepted = s.gw.say(&chat, "What does this mean?").await?;
    let turn = s.gw.accepted_turn(&accepted).await?;
    script.wait_reporting().await;
    let progress = data(
        s.gw.get(&format!("/canon/epics/{first}/progress")).await?,
        200,
    );
    assert_eq!(progress["running"], true, "{progress}");
    let epic = data(s.gw.get(&format!("/canon/epics/{first}")).await?, 200);
    assert_eq!(epic["running"], true, "{epic}");
    let refusal = delete(&s, &epic, &epic["revision"]).await?;
    assert_eq!(refusal.status, 409, "{}", refusal.text);
    assert_eq!(refusal.body["error"]["code"], "running");
    script.finish_report();
    s.gw.wait_terminal(&chat, &turn, Duration::from_secs(30))
        .await?;
    let progress = data(
        s.gw.get(&format!("/canon/epics/{first}/progress")).await?,
        200,
    );
    assert_eq!(progress["running"], false, "{progress}");
    assert_eq!(canon.query_row::<String,_,_>("SELECT w.status FROM canon_epic_work_links l JOIN btcc_guided_works w ON w.work_id=l.btcc_work_id WHERE l.epic_id=?1", [&first], |r|r.get(0))?, "open");
    assert_eq!(delete(&s, &epic, &epic["revision"]).await?.status, 200);
    let app =
        butler_platform::sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    panels::wait_settled(&app, &source).await?;
    assert_deleted(&s, &chat, &first, &source).await?;
    drop(app);
    drop(canon);
    s.finish().await?;
    server.abort();
    Ok(())
}

/// An earlier closed Work cannot hide admission of new work in a bound chat.
#[tokio::test]
async fn epic_delete_bound_live_turn_still_blocks_after_a_closed_work() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let (s, script, server, first, chat) =
        crate::canon_link::setup("EPIC-DELETE-BOUND-AGAIN", false, false).await?;
    script.release();
    s.turn(&chat, &format!("Process canon:epic/{first} now"))
        .await?;
    let canon = db(&s)?;
    assert_eq!(count(&canon, "canon_epic_work_links", &first), 1);
    script.quick.store(true, Ordering::SeqCst);
    script.hold_report.store(true, Ordering::SeqCst);
    let accepted = s.gw.say(&chat, "What does this mean?").await?;
    let turn = s.gw.accepted_turn(&accepted).await?;
    script.wait_reporting().await;
    let epic = data(s.gw.get(&format!("/canon/epics/{first}")).await?, 200);
    let refusal = delete(&s, &epic, &epic["revision"]).await?;
    assert_eq!(refusal.status, 409, "{}", refusal.text);
    assert_eq!(refusal.body["error"]["code"], "running");
    script.finish_report();
    s.gw.wait_terminal(&chat, &turn, Duration::from_secs(30))
        .await?;
    assert_eq!(delete(&s, &epic, &epic["revision"]).await?.status, 200);
    drop(canon);
    s.finish().await?;
    server.abort();
    Ok(())
}
