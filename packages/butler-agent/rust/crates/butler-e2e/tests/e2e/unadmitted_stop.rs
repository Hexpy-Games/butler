//! Stop of a turn BTCC never admitted, and schedules after a restart: the
//! App settles the Stop from BTCC's own record (Q-02 owner decision: Stop
//! pauses the queue), and due schedules wait for the executor instead of
//! failing.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::fs;
use std::time::{Duration, Instant};

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::gateway::turn_state;
use butler_e2e::e2e::provider::Pacing;
use butler_e2e::e2e::scenario::{Scenario, Setup, turn_timeout};
use butler_platform::sqlite;
use serde_json::{Value, json};

const HELD: &str = "client-00000000-0000-4000-8000-0000000000a1";
const FOLLOW_UP: &str = "client-00000000-0000-4000-8000-0000000000a2";
const STOPPED: &str = "Reply with exactly the word: stopped";
const NUMBERS: &str = "Write the numbers from one to twelve as English words, separated by single spaces, and nothing else.";
const APP_DB: &str = "app-server/butler-client.sqlite";

fn app_db(s: &Scenario) -> sqlite::Connection {
    sqlite::open(s.sandbox.data.join(APP_DB)).expect("open isolated App database")
}

async fn wait_file(s: &Scenario, name: &str) {
    let path = s.sandbox.data.join(name);
    let deadline = Instant::now() + Duration::from_secs(20);
    while !path.exists() {
        assert!(Instant::now() < deadline, "{name} never appeared");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// The queued row, cancel request and pause of the stopped turn.
fn stop_rows(s: &Scenario, turn: &str) -> (String, Option<String>, String, bool) {
    let db = app_db(s);
    let (queued, code) = db
        .query_row(
            "SELECT state,safe_error_code FROM session_queued_messages WHERE turn_id=?1",
            [turn],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    let outbox = db
        .query_row(
            "SELECT state FROM app_turn_cancel_outbox WHERE turn_id=?1",
            [turn],
            |row| row.get(0),
        )
        .unwrap();
    let paused = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM session_queue_pauses WHERE chat_id='general')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    (queued, code, outbox, paused)
}

/// Turns the in-flight admission of `HELD` into a turn whose queued input
/// waits `queued` again (the shape a dispatch-lease recovery leaves) and that
/// BTCC never received, then stops it while dispatch readiness is held.
async fn stop_unadmitted_turn(s: &mut Scenario) -> Result<String, HarnessError> {
    // Queue behind a running turn so its completion wakes dispatch, and
    // establishes the binding needed for BTCC to confirm the later Stop.
    s.provider()?.set_pacing(Pacing {
        scale: 1.0,
        cap_ms: 300,
        min_ms: 200,
    });
    let first = s.gw.say_turn("general", NUMBERS).await?;
    let queued =
        s.gw.post(
            "/session-queue",
            json!({"chat_id":"general","text":STOPPED,"client_message_id":HELD}),
        )
        .await?;
    assert_eq!(queued.status, 202, "{}", queued.text);
    let follow_up =
        s.gw.post(
            "/session-queue",
            json!({"chat_id":"general","text":NUMBERS,"client_message_id":FOLLOW_UP}),
        )
        .await?;
    assert_eq!(follow_up.status, 202, "{}", follow_up.text);
    let delivered =
        s.gw.wait_terminal("general", &first, Duration::from_secs(turn_timeout()))
            .await?;
    assert_eq!(turn_state(&delivered), "delivered", "{delivered}");
    wait_file(s, "e2e-queue-admission-held").await;
    let turns = s.gw.turns("general").await?;
    let turn = turns
        .iter()
        .find(|turn| turn["user_message_id"] == HELD)
        .unwrap_or_else(|| panic!("held admission has no turn: {turns:?}"));
    let turn_id = turn["id"].as_str().unwrap().to_owned();
    s.agent.terminate().await?;
    {
        let db = app_db(s);
        let (state, claim): (String, Option<String>) = db
            .query_row(
                "SELECT state,claim_id FROM session_queued_messages WHERE turn_id=?1",
                [&turn_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((state.as_str(), claim), ("queued", None));
    }
    s.agent.launch.set_env("BUTLER_E2E_HOLD_QUEUE_MESSAGE", "");
    s.agent
        .launch
        .set_env("BUTLER_E2E_HOLD_DISPATCH_READY", "1");
    s.gw = s.agent.start_again().await?;
    wait_file(s, "e2e-dispatch-ready-held").await;
    let cancel =
        s.gw.post(&format!("/turns/{turn_id}/cancel"), json!({}))
            .await?;
    assert_eq!(cancel.status, 202, "{}", cancel.text);
    let turn = s.gw.turn("general", &turn_id).await?.unwrap();
    assert_eq!(turn_state(&turn), "cancelling", "{turn}");
    fs::write(
        s.sandbox.data.join("e2e-dispatch-ready-release"),
        b"release",
    )?;
    Ok(turn_id)
}

/// Asserts BTCC recorded the Stop and never admitted the turn.
fn assert_never_admitted(s: &Scenario, turn: &str) {
    let btcc = sqlite::open(s.sandbox.data.join("agent-runtime/btcc.sqlite")).unwrap();
    let status: String = btcc
        .query_row(
            "SELECT status FROM btcc_stop_requests WHERE turn_id=?1",
            [turn],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(status, "cancelled_before_admission");
    let admitted: bool = btcc
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM btcc_turns WHERE turn_id=?1)",
            [turn],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!admitted, "BTCC admitted the stopped turn");
}

fn assert_settled(s: &Scenario, turn: &str, paused: bool) {
    assert_eq!(
        stop_rows(s, turn),
        (
            "failed".to_owned(),
            Some("turn_cancelled".to_owned()),
            "completed".to_owned(),
            paused
        )
    );
}

/// A Stop must preserve the full queue, including across recovery.
async fn assert_follow_up_paused(s: &Scenario) -> Result<(), HarnessError> {
    tokio::time::sleep(Duration::from_secs(2)).await;
    let view = s.gw.get("/session-queue?chat_id=general").await?;
    assert_eq!(view.status, 200, "{}", view.text);
    assert_eq!(view.data()["paused"], true, "{}", view.text);
    let items = view.data()["queued_messages"].as_array().unwrap();
    assert_eq!(items.len(), 1, "{}", view.text);
    assert_eq!(items[0]["client_message_id"], FOLLOW_UP, "{}", view.text);
    let row: (String, Option<String>, Option<String>) = app_db(s).query_row(
        "SELECT state,safe_error_code,turn_id FROM session_queued_messages WHERE client_message_id=?1",
        [FOLLOW_UP], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).unwrap();
    assert_eq!(row, ("queued".into(), None, None));
    assert_eq!(
        s.provider()?.served(),
        1,
        "paused follow-up reached provider"
    );
    Ok(())
}

/// New user input is the public API that resumes a stopped queue.
async fn resume_and_deliver_follow_up(s: &Scenario) -> Result<(), HarnessError> {
    let (_, resumed) = s.turn("general", NUMBERS).await?;
    assert_eq!(turn_state(&resumed), "delivered", "{resumed}");
    let turns = s.gw.turns("general").await?;
    let follow_up = turns
        .iter()
        .find(|turn| turn["user_message_id"] == FOLLOW_UP)
        .unwrap_or_else(|| panic!("follow-up dropped: {turns:?}"));
    assert_eq!(turn_state(follow_up), "delivered", "{follow_up}");
    let row: (String, Option<String>) = app_db(s)
        .query_row(
            "SELECT state,safe_error_code FROM session_queued_messages WHERE client_message_id=?1",
            [FOLLOW_UP],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(row, ("dispatched".into(), None));
    let view = s.gw.get("/session-queue?chat_id=general").await?;
    assert_eq!(view.data()["paused"], false, "{}", view.text);
    assert_eq!(view.data()["queued_messages"], json!([]), "{}", view.text);
    assert_eq!(s.provider()?.served(), 3, "stopped turn must never run");
    Ok(())
}

async fn create_schedule(s: &Scenario) -> Result<String, HarnessError> {
    let created =
        s.gw.post(
            "/automations",
            json!({"title": "Numbers", "prompt_body": NUMBERS,
                "target_session_id": "general", "interval_seconds": 3600}),
        )
        .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    Ok(created.data()["automation"]["id"]
        .as_str()
        .unwrap()
        .to_owned())
}

/// Makes the schedule due; the agent must be stopped.
fn make_due(s: &Scenario, id: &str) {
    let changed = app_db(s)
        .execute(
            "UPDATE app_automations SET next_run_at='2020-01-01T00:00:00.000Z' WHERE id=?1",
            [id],
        )
        .unwrap();
    assert_eq!(changed, 1);
}

async fn runs(s: &Scenario, id: &str) -> Result<Vec<Value>, HarnessError> {
    let reply = s.gw.get(&format!("/automations/{id}/runs")).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    Ok(reply.data()["runs"].as_array().cloned().unwrap_or_default())
}

/// Waits for the schedule's single run to start a turn and that turn to be delivered.
async fn assert_schedule_delivers(s: &Scenario, id: &str) -> Result<(), HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(turn_timeout());
    let turn = loop {
        let runs = runs(s, id).await?;
        assert!(
            runs.iter().all(|run| run["state"] != "failed"),
            "schedule failed: {runs:?}"
        );
        if let [run] = runs.as_slice()
            && run["state"] == "succeeded"
        {
            break run["turn_id"].as_str().unwrap().to_owned();
        }
        assert!(Instant::now() < deadline, "schedule never ran: {runs:?}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    let turn =
        s.gw.wait_terminal("general", &turn, Duration::from_secs(turn_timeout()))
            .await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    Ok(())
}

/// Q-02 — Stop of a turn whose input waits queued again and that BTCC never
/// admitted ends cancelled without further input; the queue stays paused.
#[tokio::test]
async fn q_02_stop_of_an_unadmitted_turn_settles() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("Q-02-UNADMITTED-STOP")?
        .cassette("TURN-01")
        .replay_only()
        .env("BUTLER_E2E_TIER", "stub")
        .env("BUTLER_E2E_HOLD_QUEUE_MESSAGE", HELD)
        .start()
        .await?;
    let turn = stop_unadmitted_turn(&mut s).await?;
    let settled =
        s.gw.wait_terminal("general", &turn, Duration::from_secs(20))
            .await
            .unwrap_or_else(|error| panic!("{error}\n{}", s.agent.logs()));
    assert_eq!(turn_state(&settled), "cancelled", "{settled}");
    assert_settled(&s, &turn, true);
    assert_never_admitted(&s, &turn);
    assert_follow_up_paused(&s).await?;
    resume_and_deliver_follow_up(&s).await?;
    s.finish().await
}

/// Q-02 — A restart settles a Stop an earlier version left waiting (BTCC
/// recorded it, the App did not), and a due schedule for that chat then runs.
#[tokio::test]
async fn q_02_restart_settles_a_left_stop_and_runs_the_schedule() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("Q-02-LEFT-STOP")?
        // Quiet-hour holds have their own scenario.
        .clock_after_daily_jobs("2026-09-27T12:00:00.000Z")?
        .cassette("TURN-01")
        .replay_only()
        .env("BUTLER_E2E_TIER", "stub")
        .env("BUTLER_E2E_HOLD_QUEUE_MESSAGE", HELD)
        .start()
        .await?;
    let turn = stop_unadmitted_turn(&mut s).await?;
    s.gw.wait_terminal("general", &turn, Duration::from_secs(20))
        .await
        .unwrap_or_else(|error| panic!("{error}\n{}", s.agent.logs()));
    assert_follow_up_paused(&s).await?;
    let schedule = create_schedule(&s).await?;
    s.agent.terminate().await?;
    // The App state an earlier version left: BTCC answered, the App dropped it.
    app_db(&s)
        .execute_batch(&format!(
            "UPDATE turns SET state='cancelling',safe_status_label='Stopping',safe_error_code=NULL,cancellable=0 WHERE id='{turn}';
             UPDATE app_turn_cancel_outbox SET state='pending',accepted_at=NULL,completed_at=NULL WHERE turn_id='{turn}';
             UPDATE session_queued_messages SET state='queued',safe_error_code=NULL WHERE turn_id='{turn}';"
        ))
        .unwrap();
    let (_, _, outbox, paused) = stop_rows(&s, &turn);
    assert_eq!((outbox.as_str(), paused), ("pending", true));
    s.agent.launch.remove_env("BUTLER_E2E_HOLD_DISPATCH_READY");
    s.gw = s.agent.start_again().await?;
    let settled =
        s.gw.wait_terminal("general", &turn, Duration::from_secs(20))
            .await?;
    assert_eq!(turn_state(&settled), "cancelled", "{settled}");
    assert_settled(&s, &turn, true);
    assert_never_admitted(&s, &turn);
    assert_follow_up_paused(&s).await?;
    resume_and_deliver_follow_up(&s).await?;
    s.agent.terminate().await?;
    make_due(&s, &schedule);
    s.gw = s.agent.start_again().await?;
    assert_schedule_delivers(&s, &schedule).await?;
    // The user input resumed the queue the Stop paused.
    assert_settled(&s, &turn, false);
    assert_eq!(s.provider()?.served(), 4);
    s.finish().await
}

/// SCHED — A schedule due when the agent starts waits for the executor and
/// then runs, instead of failing before dispatch is ready.
#[tokio::test]
async fn sched_due_at_startup_waits_for_dispatch_readiness() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("SCHED-STARTUP-READY")?
        // Quiet-hour holds have their own scenario.
        .clock_after_daily_jobs("2026-09-27T12:00:00.000Z")?
        .cassette("TURN-01")
        .replay_only()
        .env("BUTLER_E2E_TIER", "stub")
        .start()
        .await?;
    let schedule = create_schedule(&s).await?;
    s.agent.terminate().await?;
    make_due(&s, &schedule);
    s.agent
        .launch
        .set_env("BUTLER_E2E_HOLD_DISPATCH_READY", "1");
    s.gw = s.agent.start_again().await?;
    wait_file(&s, "e2e-dispatch-ready-held").await;
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(runs(&s, &schedule).await?, [] as [Value; 0]);
    assert_eq!(s.gw.turns("general").await?, [] as [Value; 0]);
    fs::write(
        s.sandbox.data.join("e2e-dispatch-ready-release"),
        b"release",
    )?;
    assert_schedule_delivers(&s, &schedule).await?;
    assert_eq!(s.provider()?.served(), 1);
    s.finish().await
}
