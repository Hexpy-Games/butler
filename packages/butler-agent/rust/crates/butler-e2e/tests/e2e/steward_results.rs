//! A steward's delegated result is model input for the parent turn, never a
//! chat bubble (regression: the native cutover dropped the TypeScript
//! gateway's filter).
//!
//! The scenarios drive the same admission the host's result delivery uses
//! (`POST /internal/subsession-result`) with synthetic relation ids; no
//! steward runs, so the steward session view is out of reach here. The result
//! text is the text of an already recorded round of `Q-02-CANCEL`, so the
//! parent turn replays that recording and the cassette is not touched.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use butler_platform::sqlite;
use std::time::{Duration, Instant};

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::gateway::{TERMINAL, turn_id_of, turn_state};
use butler_e2e::e2e::provider::Pacing;
use butler_e2e::e2e::scenario::{Scenario, Setup};
use serde_json::{Value, json};

const OWNER: &str = "Write the numbers from one to twelve as English words, separated by single spaces, and nothing else.";
/// Recorded round reused as the delegated result's text.
const RESULT: &str = "Reply with exactly the word: paused";
const RELATION: &str = "relation-00c0ffee";
const CHAT: &str = "general";

async fn start() -> Result<Scenario, HarnessError> {
    Setup::new("STEWARD-RESULT")?
        .cassette("Q-02-CANCEL")
        .replay_only()
        .start()
        .await
}

/// Delivers a steward result to the parent chat the way the host does.
async fn deliver_result(s: &Scenario, result_id: &str) -> Result<Value, HarnessError> {
    let reply =
        s.gw.post(
            "/internal/subsession-result",
            json!({
                "relation_id": RELATION, "result_id": result_id, "safe_title": "Atlas",
                "parent_chat_id": CHAT, "text": RESULT,
                "model_ref": s.model.model,
                "reasoning_effort": s.model.effort.clone().unwrap_or_else(|| "low".into()),
                "access_mode": "full_access",
            }),
        )
        .await?;
    assert_eq!(reply.status, 202, "{}", reply.text);
    Ok(reply.data().clone())
}

async fn wait_turns(s: &Scenario, count: usize) -> Result<Vec<Value>, HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        let turns = s.gw.turns(CHAT).await?;
        let settled = turns
            .iter()
            .all(|turn| TERMINAL.contains(&turn_state(turn)));
        if turns.len() == count && settled {
            return Ok(turns);
        }
        assert!(Instant::now() < deadline, "turns not settled: {turns:?}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Everything the owner can read about the result turn stays free of the
/// result text, while the turn keeps the marker the steward views read.
async fn assert_result_is_hidden(s: &Scenario, result_id: &str) -> Result<(), HarnessError> {
    let turns = wait_turns(s, 2).await?;
    let marker = &turns[1]["execution_controls"]["subsession_result"];
    assert_eq!(marker["result_id"], result_id, "marker lost: {}", turns[1]);
    assert_eq!(marker["relation_id"], RELATION);

    let messages = s.gw.messages(CHAT).await?;
    let asked: Vec<&str> = messages
        .iter()
        .filter(|message| message["role"] == "user")
        .filter_map(|message| message["text"].as_str())
        .collect();
    assert_eq!(asked, [OWNER], "the result is visible: {messages:?}");

    let result_turn = turn_id_of(&turns[1]).unwrap();
    let events = s.gw.events_since(0).await?;
    let user_bubbles = events.iter().filter(|event| {
        event["type"] == "message.created" && event["payload"]["message"]["role"] == "user"
    });
    assert_eq!(user_bubbles.count(), 1, "a result event was published");
    assert!(
        events.iter().any(|event| {
            event["type"] == "turn.state_changed"
                && event["payload"]["turn"]["id"].as_str() == Some(result_turn)
        }),
        "the result turn is not announced"
    );

    let export =
        s.gw.get(&format!("/transcript-export?session_id={CHAT}"))
            .await?;
    assert_eq!(export.status, 200, "{}", export.text);
    assert!(export.text.contains("one to twelve"), "{}", export.text);
    assert!(!export.text.contains("exactly the word"), "{}", export.text);
    Ok(())
}

/// The parent is idle: the result starts a turn at once.
#[tokio::test]
async fn a_result_delivered_to_an_idle_parent_is_not_a_bubble() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = start().await?;
    s.turn(CHAT, OWNER).await?;
    deliver_result(&s, "steward-result-1").await?;
    assert_result_is_hidden(&s, "steward-result-1").await?;
    super::prompt_history::resume_parity(&s)?;
    if std::env::var("BUTLER_PROMPT_MAIN_RECORD").as_deref() == Ok("1") {
        return s.finish().await;
    }
    let starts: Vec<Value> = std::fs::read_to_string(
        s.sandbox
            .data
            .join("metrics/request-prefix-diagnostics.jsonl"),
    )?
    .lines()
    .map(serde_json::from_str)
    .collect::<Result<Vec<_>, _>>()?;
    let result = starts
        .iter()
        .rev()
        .find(|row| row["requestStarted"] == true && row["sessionKind"] == "parent")
        .unwrap();
    assert_eq!(result["trigger"], "steward-result");
    assert_eq!(
        result["inputSections"].as_array().unwrap().last().unwrap()["id"],
        "current-request"
    );
    eprintln!(
        "DELEGATED_LAYOUT prefix_bytes={} byte_prefix_percent={} token_prefix_percent={}",
        result["prefixBytes"], result["lcpPercent"], result["lcpTokenPercent"]
    );
    s.finish().await
}

/// The parent is mid-turn: the result waits in the queue, and the marker must
/// survive the wait, the dispatch and the queue view.
#[tokio::test]
async fn a_result_queued_behind_a_running_turn_keeps_its_marker() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = start().await?;
    s.provider()?.set_pacing(Pacing {
        scale: 1.0,
        cap_ms: 300,
        min_ms: 200,
    });
    s.gw.say(CHAT, OWNER).await?;
    let deadline = Instant::now() + Duration::from_secs(20);
    while s.provider()?.served() == 0 {
        assert!(Instant::now() < deadline, "provider not reached");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let queued = deliver_result(&s, "steward-result-2").await?;
    assert!(queued["queued"].is_object(), "not queued: {queued}");

    let queue = s.gw.get(&format!("/session-queue?chat_id={CHAT}")).await?;
    assert_eq!(queue.status, 200, "{}", queue.text);
    assert!(
        !queue.text.contains("exactly the word"),
        "the queue tray shows the result: {}",
        queue.text
    );
    let stored: Vec<String> = {
        let db = sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite")).unwrap();
        let mut statement = db
            .prepare(
                "SELECT json_extract(control_resolution_json,'$.subsession_result.result_id') \
                 FROM session_queued_messages WHERE chat_id=?1 \
                 AND json_extract(control_resolution_json,'$.subsession_result') IS NOT NULL",
            )
            .unwrap();
        statement
            .query_map([CHAT], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    };
    assert_eq!(stored, ["steward-result-2"], "marker not queued");

    assert_result_is_hidden(&s, "steward-result-2").await?;
    s.finish().await
}

/// `/retry-current` on a failed result turn starts a fresh turn: it must carry
/// the marker, so the retry adds no bubble and no live message event.
#[tokio::test]
async fn retrying_a_failed_result_turn_keeps_it_off_the_chat() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = start().await?;
    s.agent.terminate().await?;
    seed_failed_result_turn(&s);
    s.agent
        .launch
        .set_env("BUTLER_E2E_HOLD_DISPATCH_READY", "1");
    s.gw = s.agent.start_again().await?;
    retry_after_dispatch_ready(&s).await?;
    let turns = wait_turns(&s, 2).await?;
    let fresh = turns
        .iter()
        .find(|turn| turn_id_of(turn) != Some("t-fault"))
        .unwrap();
    let marker = &fresh["execution_controls"]["subsession_result"];
    assert_eq!(marker["result_id"], "steward-result-5", "{fresh}");

    let messages = s.gw.messages(CHAT).await?;
    let asked: Vec<&str> = messages
        .iter()
        .filter(|message| message["role"] == "user")
        .filter_map(|message| message["text"].as_str())
        .collect();
    assert_eq!(asked, ["Owner question"], "the retry is visible");
    let events = s.gw.events_since(0).await?;
    assert!(
        !events.iter().any(|event| {
            event["type"] == "message.created" && event["payload"]["message"]["role"] == "user"
        }),
        "the retry published a user message"
    );
    s.finish().await
}

/// Hold real dispatch readiness so this regression cannot depend on startup speed.
async fn retry_after_dispatch_ready(s: &Scenario) -> Result<(), HarnessError> {
    let held = s.sandbox.data.join("e2e-dispatch-ready-held");
    let deadline = Instant::now() + Duration::from_secs(10);
    while !held.exists() {
        assert!(Instant::now() < deadline, "dispatcher hold missing");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let retry = s.gw.post("/turns/t-fault/retry-current", json!({}));
    tokio::pin!(retry);
    assert!(
        tokio::time::timeout(Duration::from_millis(150), retry.as_mut())
            .await
            .is_err(),
        "retry returned while dispatch was held"
    );
    let turns = s.gw.turns(CHAT).await?;
    assert_eq!(turns.len(), 1, "retry admitted a turn before readiness");
    assert_eq!(turn_state(&turns[0]), "runtime_fault");
    std::fs::write(
        s.sandbox.data.join("e2e-dispatch-ready-release"),
        b"release",
    )?;
    let reply = retry.await?;
    assert_eq!(reply.status, 202, "{}", reply.text);
    Ok(())
}

fn seed_failed_result_turn(s: &Scenario) {
    let db = sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite")).unwrap();
    let controls = json!({"subsession_result": {
        "relation_id": RELATION, "result_id": "steward-result-5", "safe_title": "Atlas"}});
    let fault = json!({"event": {"kind": "runtime.fault", "payload": {
        "faultId": "fault-1", "kind": "provider", "publicSummary": "The provider stopped.",
        "retryable": true}}});
    db.execute_batch(&format!(
        "INSERT INTO messages(id,chat_id,role,text,status,created_at,updated_at,retryable) VALUES
           ('m-owner','{CHAT}','user','Owner question','sent','2026-01-01T00:00:01Z','2026-01-01T00:00:01Z',0);
         INSERT INTO turns(id,chat_id,user_message_id,state,safe_status_label,retryable,execution_controls_json,created_at,updated_at)
           VALUES('t-fault','{CHAT}','m-fault','runtime_fault','Failed',1,'{controls}',
             '2026-01-01T00:00:02Z','2026-01-01T00:00:02Z');
         INSERT INTO messages(id,chat_id,turn_id,role,text,status,created_at,updated_at,retryable) VALUES
           ('m-fault','{CHAT}','t-fault','user','{RESULT}','sent','2026-01-01T00:00:02Z','2026-01-01T00:00:02Z',0);
         INSERT INTO events(type,turn_id,payload_json,created_at)
           VALUES('agent.turn_event','t-fault','{fault}','2026-01-01T00:00:03Z');"
    ))
    .unwrap();
}

/// Rows written before the fix (or by the TypeScript gateway) are hidden by
/// the read path with no data migration: one carries the turn marker, one
/// only the TypeScript-era structured refs.
#[tokio::test]
async fn stored_result_rows_are_hidden_without_a_migration() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("STEWARD-RESULT-STORED")?.start().await?;
    s.agent.terminate().await?;
    seed_stored_rows(&s);
    s.gw = s.agent.start_again().await?;

    let messages = s.gw.messages(CHAT).await?;
    let texts: Vec<&str> = messages
        .iter()
        .filter_map(|message| message["text"].as_str())
        .collect();
    assert_eq!(texts, ["Owner question"], "stored results are visible");
    let export =
        s.gw.get(&format!("/transcript-export?session_id={CHAT}"))
            .await?;
    assert!(export.text.contains("Owner question"), "{}", export.text);
    assert!(!export.text.contains("marked-row"), "{}", export.text);
    assert!(!export.text.contains("Relation ref"), "{}", export.text);
    // The newest stored message is a hidden result, so the preview shows the
    // owner's message only if the filter applies to the preview.
    let sessions = s.gw.get("/sessions").await?.text;
    assert!(sessions.contains("Owner question"), "{sessions}");
    assert!(!sessions.contains("marked-row"), "{sessions}");
    s.finish().await
}

fn seed_stored_rows(s: &Scenario) {
    let db = sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite")).unwrap();
    let controls = json!({"subsession_result": {
        "relation_id": RELATION, "result_id": "steward-result-3", "safe_title": "Atlas"}});
    db.execute_batch(&format!(
        "INSERT INTO messages(id,chat_id,role,text,status,created_at,updated_at,retryable) VALUES
           ('m-owner','{CHAT}','user','Owner question','sent','2026-01-01T00:00:01Z','2026-01-01T00:00:01Z',0);
         INSERT INTO turns(id,chat_id,user_message_id,state,safe_status_label,execution_controls_json,created_at,updated_at)
           VALUES('t-marked','{CHAT}','m-marked','delivered','Delivered','{controls}',
             '2026-01-01T00:00:02Z','2026-01-01T00:00:02Z');
         INSERT INTO messages(id,chat_id,turn_id,role,text,status,created_at,updated_at,retryable) VALUES
           ('m-marked','{CHAT}','t-marked','user','Delegated result marked-row','sent','2026-01-01T00:00:02Z','2026-01-01T00:00:02Z',0),
           ('m-legacy','{CHAT}',NULL,'user','Subsession result\nRelation ref: relation-0123abcd\nResult ref: steward-result-4567ef\nStatus: success','sent','2026-01-01T00:00:03Z','2026-01-01T00:00:03Z',0);"
    ))
    .unwrap();
}
