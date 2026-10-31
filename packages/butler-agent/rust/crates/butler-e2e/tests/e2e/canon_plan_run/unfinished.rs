//! A step whose Turn ends with nothing closed stops and asks, once. A reply that
//! finishes its Work clears the card and the run goes on.
use super::holds::wait_state;
use super::*;
use butler_e2e::e2e::scenario::Scenario;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

fn cards(s: &Scenario) -> Result<Vec<(String, String)>, HarnessError> {
    let app = rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    let rows = app
        .prepare(
            "SELECT text,json_extract(payload_json,'$.panel.state') FROM app_initiated_messages WHERE kind='canon_hold' ORDER BY rowid",
        )?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

async fn wait_card(s: &Scenario, state: &str) -> Result<Vec<(String, String)>, HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let cards = cards(s)?;
        if cards.iter().any(|(_, panel)| panel == state) {
            return Ok(cards);
        }
        assert!(Instant::now() < deadline, "no {state} card: {cards:?}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

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

/// A model that asks a question keeps a way forward: answering it finishes the step.
#[tokio::test]
async fn step_turn_without_work_holds_until_the_reply_finishes_it() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, script, server, first, chat) =
        crate::canon_link::setup("CB-D3", false, false).await?;
    let (plan, epics) = plan(&s, &script, &first).await?;
    script.quick.store(true, Ordering::SeqCst);
    script.release();
    run_plan(&s, &chat, &plan).await?;
    let turn = first_turn(&s, &chat).await?;
    s.gw.wait_terminal(&chat, &turn, Duration::from_secs(30))
        .await?;
    assert!(
        s.gw.messages(&chat)
            .await?
            .iter()
            .any(|m| m["text"] == "Which evidence should I check?")
    );
    let view = wait_state(&s, &chat, &epics[1], "held").await?;
    assert_eq!(
        view["counts"],
        json!({"running":0,"failed":1,"held":2,"waiting":0})
    );
    let shown = wait_card(&s, "pending").await?;
    assert_eq!(shown.len(), 1, "{shown:?}");
    assert!(shown[0].0.ends_with("Reply to continue."), "{shown:?}");
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    assert_eq!(
        db.query_row::<i64, _, _>(
            "SELECT count(*) FROM canon_intents WHERE kind='canon_step'",
            [],
            |r| r.get(0)
        )?,
        1,
        "later steps wait behind the card"
    );
    drop(db);
    // Neither another question nor a restart asks twice.
    s.turn(&chat, "What does this mean?").await?;
    s.restart().await?;
    assert_eq!(cards(&s)?.len(), 1, "the step asked twice");
    script.quick.store(false, Ordering::SeqCst);
    s.gw.say(&chat, &format!("Process canon:epic/{} now", epics[0]))
        .await?;
    wait_done(&s, &chat, 3).await?;
    let settled = wait_card(&s, "resolved").await?;
    assert_eq!(settled.len(), 1, "{settled:?}");
    s.finish().await?;
    server.abort();
    Ok(())
}

/// A Turn ending on an open Work stops the same way. The runtime keeps asking for a
/// closeout until its budget ends the Turn (over 1,200 stub model calls), so this
/// links the step to a Work a stopped Turn left open while the step's reply is held.
#[tokio::test]
async fn step_turn_ending_on_an_open_work_holds_until_the_reply_finishes_it()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, first, chat) =
        crate::canon_link::setup("CB-UNFINISHED-OPEN", false, false).await?;
    let (plan, epics) = plan(&s, &script, &first).await?;
    let accepted =
        s.gw.say(&chat, &format!("Process canon:epic/{} now", epics[0]))
            .await?;
    let stopped = s.gw.accepted_turn(&accepted).await?;
    script.wait_held().await;
    data(
        s.gw.post(&format!("/turns/{stopped}/cancel"), json!({}))
            .await?,
        202,
    );
    script.release();
    s.gw.wait_terminal(&chat, &stopped, Duration::from_secs(30))
        .await?;
    script.quick.store(true, Ordering::SeqCst);
    script.hold_report.store(true, Ordering::SeqCst);
    run_plan(&s, &chat, &plan).await?;
    script.wait_reporting().await;
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let relinked = db.execute(
        "UPDATE canon_epic_work_links SET linked_at=(SELECT started_at+1 FROM canon_session_queue WHERE epic_id=?1) WHERE epic_id=?1",
        [&epics[0]],
    )?;
    assert_eq!(relinked, 1, "the stopped Turn's Work was not linked");
    let open: String = db.query_row(
        "SELECT w.status FROM canon_epic_work_links l JOIN btcc_guided_works w ON w.work_id=l.btcc_work_id WHERE l.epic_id=?1",
        [&epics[0]],
        |r| r.get(0),
    )?;
    assert_eq!(open, "open");
    assert_eq!(cards(&s)?.len(), 0, "the Turn is still in progress");
    script.finish_report();
    wait_state(&s, &chat, &epics[1], "held").await?;
    assert_eq!(wait_card(&s, "pending").await?.len(), 1);
    drop(db);
    script.quick.store(false, Ordering::SeqCst);
    s.gw.say(&chat, &format!("Process canon:epic/{} now", epics[0]))
        .await?;
    wait_done(&s, &chat, 3).await?;
    assert_eq!(wait_card(&s, "resolved").await?.len(), 1);
    s.finish().await?;
    server.abort();
    Ok(())
}

/// Found live: a model that asks may record the Work as blocked until it hears back.
#[tokio::test]
async fn blocked_step_clears_when_the_reply_finishes_its_work() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, first, chat) =
        crate::canon_link::setup("CB-UNFINISHED-BLOCKED", false, false).await?;
    let (plan, epics) = plan(&s, &script, &first).await?;
    script.blocked.lock().unwrap().push(epics[0].clone());
    script.release();
    run_plan(&s, &chat, &plan).await?;
    wait_state(&s, &chat, &epics[1], "held").await?;
    let shown = wait_card(&s, "pending").await?;
    assert_eq!(shown.len(), 1, "{shown:?}");
    script.blocked.lock().unwrap().clear();
    s.gw.say(&chat, &format!("Process canon:epic/{} now", epics[0]))
        .await?;
    wait_done(&s, &chat, 3).await?;
    assert_eq!(wait_card(&s, "resolved").await?.len(), 1);
    s.finish().await?;
    server.abort();
    Ok(())
}

/// Found live twice: the reply's first review on a Work blocked to ask failed the Turn.
#[tokio::test]
async fn work_blocked_to_ask_finishes_on_the_reply() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, first, chat) =
        crate::canon_link::setup("CB-UNFINISHED-ASK", false, false).await?;
    let (plan, epics) = plan(&s, &script, &first).await?;
    script.ask_blocked.store(true, Ordering::SeqCst);
    script.release();
    run_plan(&s, &chat, &plan).await?;
    wait_state(&s, &chat, &epics[1], "held").await?;
    wait_card(&s, "pending").await?;
    s.turn(&chat, &format!("Process canon:epic/{} now", epics[0]))
        .await?;
    wait_state(&s, &chat, &epics[0], "done").await?;
    assert_eq!(wait_card(&s, "resolved").await?.len(), 1);
    s.finish().await?;
    server.abort();
    Ok(())
}

/// Found live: a plan already in review, queued again, got a plain reply and no card.
#[tokio::test]
async fn requeued_plan_in_review_reaches_the_card() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, first, chat) =
        crate::canon_link::setup("CB-UNFINISHED-REQUEUE", false, false).await?;
    let (plan, epics) = plan(&s, &script, &first).await?;
    script.release();
    run_plan(&s, &chat, &plan).await?;
    wait_done(&s, &chat, 3).await?;
    script.quick.store(true, Ordering::SeqCst);
    run_plan(&s, &chat, &plan).await?;
    wait_state(&s, &chat, &epics[1], "held").await?;
    assert_eq!(wait_card(&s, "pending").await?.len(), 1);
    s.finish().await?;
    server.abort();
    Ok(())
}

/// Found live: a step in General got a plain reply and no card.
#[tokio::test]
async fn general_step_without_work_reaches_the_card() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, first, _) =
        crate::canon_link::setup("CB-UNFINISHED-GENERAL", false, false).await?;
    script.quick.store(true, Ordering::SeqCst);
    data(
        s.gw.post(
            "/sessions/general/canon/queue",
            json!({"op":"start_now","epic_id":first}),
        )
        .await?,
        200,
    );
    assert_eq!(wait_card(&s, "pending").await?.len(), 1);
    s.finish().await?;
    server.abort();
    Ok(())
}

/// A Turn still in progress is never unfinished, however long it takes.
#[tokio::test]
async fn step_turn_in_progress_gets_no_card() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, first, chat) =
        crate::canon_link::setup("CB-UNFINISHED-PROGRESS", false, false).await?;
    let (plan, _) = plan(&s, &script, &first).await?;
    run_plan(&s, &chat, &plan).await?;
    script.wait_held().await;
    let view = data(
        s.gw.get(&format!("/sessions/{chat}/canon/queue")).await?,
        200,
    );
    assert_eq!(view["counts"]["failed"], 0, "{view}");
    assert_eq!(view["counts"]["running"], 1, "{view}");
    assert_eq!(cards(&s)?, [] as [(String, String); 0]);
    script.release();
    wait_done(&s, &chat, 3).await?;
    assert_eq!(cards(&s)?, [] as [(String, String); 0]);
    s.finish().await?;
    server.abort();
    Ok(())
}

/// The step's own Turn ended, but its Steward can still close the Work.
#[tokio::test]
async fn delegated_step_gets_no_card_while_its_steward_runs() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, first, chat) =
        crate::canon_link::setup("CB-UNFINISHED-DELEGATED", false, false).await?;
    let (plan, _) = plan(&s, &script, &first).await?;
    script.delegate.store(true, Ordering::SeqCst);
    run_plan(&s, &chat, &plan).await?;
    script.wait_held().await;
    let turn = first_turn(&s, &chat).await?;
    s.gw.wait_terminal(&chat, &turn, Duration::from_secs(30))
        .await?;
    let view = data(
        s.gw.get(&format!("/sessions/{chat}/canon/queue")).await?,
        200,
    );
    assert_eq!(view["counts"]["failed"], 0, "{view}");
    script.release();
    wait_done(&s, &chat, 3).await?;
    assert_eq!(cards(&s)?, [] as [(String, String); 0]);
    s.finish().await?;
    server.abort();
    Ok(())
}
