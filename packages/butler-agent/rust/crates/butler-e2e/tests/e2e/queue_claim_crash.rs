//! #1112: a crash after an App message's inbound record is visible, but
//! before the record is claimed or its enqueue receipt returns, processes the
//! message exactly once and settles its turn after restart.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::{
    path::Path,
    time::{Duration, Instant},
};

use butler_e2e::e2e::{
    HarnessError,
    gateway::{TERMINAL, turn_state},
    matching,
    provider::Script,
    sanitize::Placeholders,
    scenario::{Scenario, Setup},
};
use serde_json::{Value, json};

/// Record visible, receipt not returned; still pending; leased, not dispatched.
const POINTS: [&str; 3] = [
    "inbound_enqueue_renamed",
    "inbound_claim_staged",
    "inbound_claim_leased",
];

fn setup(name: &str, point: &str) -> Result<Setup, HarnessError> {
    Ok(Setup::new(name)?
        .synthetic(Script {
            rounds: 0,
            path_for: Box::new(|_| String::new()),
            final_text: "Done.".into(),
        })
        .env("BUTLER_E2E_ABORT_POINT", point))
}

#[tokio::test]
async fn crash_before_claim_or_receipt_processes_each_message_once() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for point in POINTS {
        let mut s = setup(&format!("QUEUE-CLAIM-CRASH-{point}"), point)?
            .start()
            .await?;
        let prompt = format!("Crash window {point}");
        let gw = s.gw.clone();
        let text = prompt.clone();
        let sent = tokio::spawn(async move { gw.say("general", &text).await });
        aborted(&mut s).await?;
        let _ = sent.await;
        restart_clean(&mut s).await?;
        let started = Instant::now();
        settled_once(&mut s, &[prompt]).await?;
        eprintln!(
            "{point}: settled once after restart in {:?}",
            started.elapsed()
        );
        s.finish().await?;
    }
    Ok(())
}

/// The active turn's record is in the window while follow-ups wait in the
/// App queue: all of them run once, in order, after restart.
#[tokio::test]
async fn crash_in_claim_window_keeps_the_full_queue_once_and_in_order() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    for point in &POINTS[1..] {
        let mut s = setup(&format!("QUEUE-CLAIM-CRASH-FULL-{point}"), point)?
            .env("BUTLER_E2E_HOLD_QUEUE_CLAIMS", "1")
            .start()
            .await?;
        let prompts: Vec<String> = (1..=3)
            .map(|index| format!("Queued message {index} at {point}"))
            .collect();
        s.gw.say("general", &prompts[0]).await?;
        // The first message's record is published; its claim waits here.
        wait_path(&s.sandbox.data.join("e2e-queue-claims-held")).await?;
        for prompt in &prompts[1..] {
            let queued =
                s.gw.post(
                    "/session-queue",
                    json!({"chat_id":"general","text":prompt,
                        "client_message_id":uuid::Uuid::new_v4().to_string()}),
                )
                .await?;
            assert_eq!(queued.status, 202, "{}", queued.text);
        }
        std::fs::write(s.sandbox.data.join("e2e-queue-claims-release"), b"release")?;
        aborted(&mut s).await?;
        s.agent.launch.remove_env("BUTLER_E2E_HOLD_QUEUE_CLAIMS");
        restart_clean(&mut s).await?;
        settled_once(&mut s, &prompts).await?;
        s.finish().await?;
    }
    Ok(())
}

async fn aborted(s: &mut Scenario) -> Result<(), HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(30);
    while s.agent.is_running() {
        assert!(
            Instant::now() < deadline,
            "abort point not reached\n{}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let status = s.agent.reap().expect("aborted agent status");
    assert!(!status.success(), "agent exited cleanly: {status}");
    Ok(())
}

async fn restart_clean(s: &mut Scenario) -> Result<(), HarnessError> {
    s.agent.launch.remove_env("BUTLER_E2E_ABORT_POINT");
    s.gw = s.agent.start_again().await?;
    Ok(())
}

async fn wait_path(path: &Path) -> Result<(), HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !path.exists() {
        assert!(Instant::now() < deadline, "missing {}", path.display());
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    Ok(())
}

/// Every prompt has one terminal turn, one queue record and at most one model
/// request; a delivered turn has exactly one answer. Order is kept.
async fn settled_once(s: &mut Scenario, prompts: &[String]) -> Result<(), HarnessError> {
    let turns = terminal_turns(s, prompts.len()).await?;
    let messages = s.gw.messages("general").await?;
    let users: Vec<&Value> = messages.iter().filter(|m| m["role"] == "user").collect();
    let texts: Vec<&str> = users.iter().filter_map(|m| m["text"].as_str()).collect();
    assert_eq!(texts, prompts, "user messages: {messages:?}");
    let requests = model_requests(s, prompts)?;
    let mut cursor = 0;
    for ((prompt, user), requested) in prompts.iter().zip(&users).zip(requests) {
        let turn = turns
            .iter()
            .find(|turn| turn["id"] == user["turn_id"])
            .unwrap_or_else(|| panic!("no turn for {prompt}: {turns:?}"));
        // Turns are dispatched in queue order.
        let next = turn["cursor"].as_u64().unwrap();
        assert!(next > cursor, "{prompt} dispatched out of order: {turns:?}");
        cursor = next;
        eprintln!(
            "{prompt}: state={} model_calls={requested}",
            turn_state(turn)
        );
        let answers = messages
            .iter()
            .filter(|m| m["role"] == "assistant" && m["turn_id"] == turn["id"])
            .count();
        match turn_state(turn) {
            "delivered" => {
                assert_eq!(answers, 1, "{prompt}: {messages:?}");
                assert_eq!(requested, 1, "{prompt}: model calls");
            }
            "failed" => {
                // Crash policy: a turn the crashed process owned ends
                // failed and retryable; it never runs twice.
                assert_eq!(turn["retryable"], true, "{turn}");
                assert_eq!(answers, 0, "{prompt}: {messages:?}");
                assert!(requested <= 1, "{prompt}: model calls {requested}");
            }
            other => panic!("{prompt}: unexpected terminal state {other}: {turn}"),
        }
    }
    wait_queue_drained(&s.sandbox.data).await;
    assert_queue_records(&s.sandbox.data, prompts)?;
    assert_app_rows(&s.sandbox.data, prompts.len())?;
    Ok(())
}

async fn terminal_turns(s: &mut Scenario, count: usize) -> Result<Vec<Value>, HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        s.supervise().await?;
        let turns = s.gw.turns("general").await?;
        let queue = s.gw.get("/session-queue?chat_id=general").await?;
        let waiting = queue.data()["queued_messages"]
            .as_array()
            .is_some_and(|items| items.iter().any(|item| item["state"] == "queued"));
        if turns.len() == count
            && !waiting
            && turns
                .iter()
                .all(|turn| TERMINAL.contains(&turn_state(turn)))
        {
            return Ok(turns);
        }
        assert!(
            Instant::now() < deadline,
            "turns not terminal after restart: {turns:?}\nqueue: {}\n{}",
            queue.text,
            queue_listing(&s.sandbox.data)
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn model_requests(s: &Scenario, prompts: &[String]) -> Result<Vec<usize>, HarnessError> {
    let requests = s.provider()?.requests();
    Ok(prompts
        .iter()
        .map(|prompt| {
            requests
                .iter()
                .filter(|body| {
                    matching::key("/codex/responses", body, &Placeholders::default()).user_request
                        == *prompt
                })
                .count()
        })
        .collect())
}

fn queue_records(data: &Path, state: &str) -> Vec<(String, Value)> {
    let dir = data.join("runtime/inbound-events").join(state);
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().ends_with(".json"))
        .filter_map(|entry| {
            let record = serde_json::from_slice(&std::fs::read(entry.path()).ok()?).ok()?;
            Some((entry.file_name().to_string_lossy().into_owned(), record))
        })
        .collect()
}

fn queue_listing(data: &Path) -> String {
    ["pending", "processing", "processed", "failed"]
        .iter()
        .map(|state| {
            let names: Vec<String> = queue_records(data, state)
                .into_iter()
                .map(|(name, _)| name)
                .collect();
            format!("{state}: {names:?}")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// A turn is terminal before the native queue moves its record to `processed/`;
/// wait for that move so the record check does not race it.
async fn wait_queue_drained(data: &Path) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline
        && ["pending", "processing"]
            .iter()
            .any(|state| !queue_records(data, state).is_empty())
    {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn assert_queue_records(data: &Path, prompts: &[String]) -> Result<(), HarnessError> {
    let listing = queue_listing(data);
    for state in ["pending", "processing"] {
        assert!(queue_records(data, state).is_empty(), "{listing}");
    }
    let settled: Vec<(String, Value)> = ["processed", "failed"]
        .iter()
        .flat_map(|state| queue_records(data, state))
        .filter(|(_, record)| record["envelope"]["transport"] == "app")
        .collect();
    assert!(
        settled.iter().all(|(name, _)| !name.contains("reconcile")),
        "{listing}"
    );
    for prompt in prompts {
        let records = settled
            .iter()
            .filter(|(_, record)| record["envelope"]["message"]["text"] == prompt.as_str())
            .count();
        assert_eq!(records, 1, "{prompt}: {listing}");
    }
    Ok(())
}

fn assert_app_rows(data: &Path, count: usize) -> Result<(), HarnessError> {
    let db = butler_platform::sqlite::open(data.join("app-server/butler-client.sqlite"))
        .map_err(|error| HarnessError(error.to_string()))?;
    let mut statement = db.prepare("SELECT state FROM session_queued_messages ORDER BY rowid")?;
    let states: Vec<String> = statement
        .query_map([], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    assert_eq!(states.len(), count, "{states:?}");
    assert!(
        states
            .iter()
            .all(|state| state == "dispatched" || state == "failed"),
        "{states:?}"
    );
    Ok(())
}
