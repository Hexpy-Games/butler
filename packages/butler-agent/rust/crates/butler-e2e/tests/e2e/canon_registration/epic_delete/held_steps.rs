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

/// A stopped Work stays open in BTCC, but a continued step or its replacement
/// must not borrow the live Turn of a later conversation reply.
async fn stopped_work_delete(replace: bool) -> Result<(), HarnessError> {
    let (s, script, server, first, chat) =
        crate::canon_link::setup("EPIC-DELETE-STOPPED-SCOPE", false, false).await?;
    unfinished::run_plan(&s, &chat, &fixture::plan(&s, &script, &first).await?.0).await?;
    script.wait_held().await;
    let turn = s.gw.turns(&chat).await?[0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    data(
        s.gw.post(&format!("/turns/{turn}/cancel"), json!({}))
            .await?,
        202,
    );
    script.release();
    s.gw.wait_terminal(&chat, &turn, Duration::from_secs(30))
        .await?;
    unfinished::wait_card(&s, "pending").await?;
    let canon = db(&s)?;
    let stopped: String = canon.query_row(
        "SELECT btcc_work_id FROM canon_epic_work_links WHERE epic_id=?1",
        [&first],
        |r| r.get(0),
    )?;
    data(
        s.gw.post(
            &format!("/sessions/{chat}/canon/queue/holds/{first}"),
            json!({"decision":if replace { "delete" } else { "continue" }}),
        )
        .await?,
        200,
    );
    fixture::wait_done(&s, &chat, if replace { 2 } else { 3 }).await?;
    if replace {
        data(
            s.gw.post(
                &format!("/sessions/{chat}/canon/queue"),
                json!({"op":"start_now","epic_id":first}),
            )
            .await?,
            200,
        );
        fixture::wait_done(&s, &chat, 3).await?;
    }
    for turn in s.gw.turns(&chat).await? {
        s.gw.wait_terminal(&chat, turn["id"].as_str().unwrap(), Duration::from_secs(30))
            .await?;
    }
    // Starting the next Work abandons today's head. Recreate the persisted open
    // predecessor that older stopped runs left behind, which canon must ignore.
    assert_eq!(
        canon.execute(
            "UPDATE btcc_guided_works SET status='open' WHERE work_id=?1",
            [&stopped]
        )?,
        1
    );
    assert_eq!(canon.query_row::<i64,_,_>("SELECT count(*) FROM canon_epic_work_links l JOIN btcc_guided_works w ON w.work_id=l.btcc_work_id WHERE l.epic_id=?1 AND w.status='open'", [&first], |r|r.get(0))?, 1);
    script.quick.store(true, Ordering::SeqCst);
    script.hold_report.store(true, Ordering::SeqCst);
    let accepted = s.gw.say(&chat, "What does this mean?").await?;
    let turn = s.gw.accepted_turn(&accepted).await?;
    script.wait_reporting().await;
    let progress = data(
        s.gw.get(&format!("/canon/epics/{first}/progress")).await?,
        200,
    );
    assert_eq!(progress["running"], false, "{progress}");
    let epic = data(s.gw.get(&format!("/canon/epics/{first}")).await?, 200);
    assert_eq!(epic["delete_blocked"], false, "{epic}");
    let reply = delete(&s, &epic, &epic["revision"]).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    script.finish_report();
    s.gw.wait_terminal(&chat, &turn, Duration::from_secs(30))
        .await?;
    drop(canon);
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn epic_delete_continued_work_ignores_later_chat_turns() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    stopped_work_delete(false).await
}
#[tokio::test]
async fn epic_delete_replaced_open_work_ignores_later_chat_turns() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    stopped_work_delete(true).await
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
