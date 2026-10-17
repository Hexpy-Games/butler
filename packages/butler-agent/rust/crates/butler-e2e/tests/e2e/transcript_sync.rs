//! One App delivery syncs its transcript once, together with the progress
//! still pending for its session. A kill around that sync loses, duplicates
//! and reorders no progress, and acknowledges nothing unsynced.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use butler_e2e::e2e::{
    HarnessError,
    gateway::{tool_rows, turn_state},
    nonce,
    scenario::{Scenario, Setup, accepted_turn_id},
};
use rusqlite::Connection;
use serde_json::Value;

const PROMPT: &str = "Read the file notes.txt in your workspace and tell me the secret word.";

/// Holds the first periodic progress append so the turn's later progress is
/// still pending when its final delivery starts, as on a slow disk.
fn setup(id: &str) -> Result<(Setup, PathBuf), HarnessError> {
    let secret = nonce();
    let setup = Setup::new(id)?
        .cassette("TOOL-01")
        .placeholder("NONCE", &secret);
    fs::write(
        setup.sandbox.data.join("notes.txt"),
        format!("the secret word is {secret}\n"),
    )?;
    let release = setup.sandbox.root.join("progress-release");
    let setup = setup
        .env("BUTLER_DEBUG_COMMAND_TIMINGS", "1")
        .env("BUTLER_E2E_HOLD_POINT", "transcript_progress_written")
        .env("BUTLER_E2E_HOLD_RELEASE", release.display().to_string());
    Ok((setup, release))
}

/// Releases the held progress append once the final delivery waits behind
/// it; returns the release time.
async fn release_behind_delivery(s: &Scenario, release: &Path) -> Result<u128, HarnessError> {
    wait_until(s, "progress hold", || {
        release.with_extension("held").exists()
    })
    .await?;
    wait_until(s, "delivery start", || {
        s.agent
            .logs()
            .contains("command_phase_timing phase=app_delivery ")
    })
    .await?;
    let released = now_us();
    // Later appends pass the hold point again without waiting.
    fs::remove_file(release.with_extension("held"))?;
    fs::write(release, b"")?;
    Ok(released)
}

#[tokio::test]
async fn each_app_delivery_syncs_its_transcript_once() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (setup, release) = setup("TRANSCRIPT-SYNC")?;
    let s = setup.start().await?;
    let id = accepted_turn_id(&s.gw.say("general", PROMPT).await?)?;
    let released = release_behind_delivery(&s, &release).await?;
    let turn =
        s.gw.wait_terminal("general", &id, Duration::from_secs(20))
            .await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let syncs = syncs_per_delivery(&s.agent.logs(), released);
    eprintln!("TRANSCRIPT-SYNC syncs per delivery: {syncs:?}");
    assert_eq!(syncs, [1], "{}", s.agent.logs());
    let progress = settled_progress(&s.sandbox.data, &id).await?;
    let outbound = outbound_actions(&s.sandbox.data)?;
    assert_once_in_order(&progress, &outbound, false);
    assert_final_after_progress(&progress, &outbound);
    assert_eq!(read_rows(&s, &id).await?, 1);
    s.finish().await
}

#[tokio::test]
async fn delivery_killed_around_its_sync_republishes_progress_once() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for point in ["transcript_delivery_written", "transcript_delivery_synced"] {
        killed_at(point).await?;
    }
    Ok(())
}

async fn killed_at(point: &str) -> Result<(), HarnessError> {
    let (setup, release) = setup(&format!("TRANSCRIPT-KILL-{point}"))?;
    let mut s = setup.env("BUTLER_E2E_ABORT_POINT", point).start().await?;
    let id = accepted_turn_id(&s.gw.say("general", PROMPT).await?)?;
    release_behind_delivery(&s, &release).await?;
    let deadline = Instant::now() + Duration::from_secs(20);
    while s.agent.is_running() {
        if Instant::now() > deadline {
            return Err(HarnessError(format!("{point}: no abort")));
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    s.agent.reap();
    let data = s.sandbox.data.clone();
    let carried = assert_unacknowledged(&data, &id, point)?;
    s.agent.launch.remove_env("BUTLER_E2E_ABORT_POINT");
    s.agent.launch.remove_env("BUTLER_E2E_HOLD_POINT");
    s.gw = s.agent.start_again().await?;
    let turn =
        s.gw.wait_terminal("general", &id, Duration::from_secs(20))
            .await?;
    let progress = settled_progress(&data, &id).await?;
    let outbound = outbound_actions(&data)?;
    assert_once_in_order(&progress, &outbound, true);
    assert_eq!(read_rows(&s, &id).await?, 1, "{point}");
    let messages = s.gw.messages("general").await?;
    let answers = messages
        .iter()
        .filter(|m| m["role"] == "assistant" && m["turn_id"] == id.as_str())
        .count();
    assert!(answers <= 1, "{point}: duplicated answer {messages:?}");
    assert_eq!(s.gw.turns("general").await?.len(), 1, "{point}");
    eprintln!(
        "TRANSCRIPT-KILL {point}: progress={} carried_by_delivery_write={carried} after_restart={}",
        progress.len(),
        turn_state(&turn)
    );
    s.finish().await
}

/// The killed write holds the delivery and the session's pending progress,
/// yet none of it is acknowledged: published progress is all in the file,
/// and the queue still owns the delivered turn. Returns the progress count
/// the delivery write carried.
fn assert_unacknowledged(data: &Path, turn: &str, point: &str) -> Result<usize, HarnessError> {
    let outbound = outbound_actions(data)?;
    let written: HashSet<&str> = outbound.iter().map(|(id, _)| id.as_str()).collect();
    let rows = progress(data, turn)?;
    for (action, status) in &rows {
        if status == "published" {
            assert!(written.contains(action.as_str()), "{point}: lost {action}");
        }
    }
    assert!(
        outbound.iter().any(|(_, kind)| kind == "final_result"),
        "{point}: killed write lacks the delivery"
    );
    let carried = rows
        .iter()
        .filter(|(action, status)| status == "pending" && written.contains(action.as_str()))
        .count();
    assert!(carried > 0, "{point}: delivery write carried no progress");
    let processing = data.join("runtime/inbound-events/processing");
    assert!(
        fs::read_dir(processing)?.next().is_some(),
        "{point}: delivery acknowledged before its sync"
    );
    Ok(carried)
}

/// For each App delivery span, the transcript appends that started after
/// `released` and synced inside the span.
fn syncs_per_delivery(logs: &str, released: u128) -> Vec<usize> {
    let field = |line: &str, name: &str| -> Option<u128> {
        line.split_whitespace()
            .find_map(|word| word.strip_prefix(name))
            .and_then(|value| value.parse().ok())
    };
    let mut deliveries = HashMap::<u128, (u128, u128)>::new();
    let mut appends = HashMap::<u128, (u128, Option<u128>)>::new();
    for line in logs.lines() {
        let (Some(id), Some(at)) = (field(line, "id="), field(line, "utc_us=")) else {
            continue;
        };
        if line.contains("command_phase_timing phase=app_delivery ") {
            let span = deliveries.entry(id).or_insert((at, at));
            *span = (span.0.min(at), span.1.max(at));
        } else if line.contains("command_gateway_timing phase=transcript_append ") {
            let span = appends.entry(id).or_insert((at, None));
            if line.contains(" event=synced ") {
                span.1 = Some(at);
            }
        }
    }
    deliveries
        .values()
        .map(|(start, end)| {
            appends
                .values()
                .filter(|(entry, synced)| {
                    *entry >= released && synced.is_some_and(|at| (start..=end).contains(&&at))
                })
                .count()
        })
        .collect()
}

/// `(action id, metadata kind)` of every outbound record, in file order.
fn outbound_actions(data: &Path) -> Result<Vec<(String, String)>, HarnessError> {
    let mut actions = Vec::new();
    for entry in fs::read_dir(data.join("transcripts"))? {
        let events: Vec<Value> = fs::read_to_string(entry?.path())?
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        for (index, event) in events.iter().enumerate() {
            if event["kind"] != "outbound" {
                continue;
            }
            let next = events.get(index + 1).expect("orphan outbound");
            assert_eq!(next["kind"], "delivery", "{event}");
            assert_eq!(next["payload"]["actionId"], event["payload"]["actionId"]);
            actions.push((
                event["payload"]["actionId"].as_str().unwrap().to_owned(),
                event["payload"]["metadata"]["kind"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned(),
            ));
        }
    }
    Ok(actions)
}

/// `(action id, status)` of a turn's progress, in source order.
fn progress(data: &Path, turn: &str) -> Result<Vec<(String, String)>, HarnessError> {
    let db = Connection::open(crate::btcc_scale::path(data))?;
    let mut rows = db.prepare(
        "SELECT action_id,status FROM btcc_progress_events \
         WHERE turn_id=?1 ORDER BY session_id,session_sequence",
    )?;
    let rows = rows
        .query_map([turn], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// The turn's progress action ids once every event is published.
async fn settled_progress(data: &Path, turn: &str) -> Result<Vec<String>, HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let rows = progress(data, turn)?;
        if !rows.is_empty() && rows.iter().all(|(_, status)| status == "published") {
            return Ok(rows.into_iter().map(|(action, _)| action).collect());
        }
        assert!(Instant::now() < deadline, "progress unpublished: {rows:?}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Every published event is in the file, first seen in source order. A
/// replay after a kill may append an event again under its stable id.
fn assert_once_in_order(progress: &[String], outbound: &[(String, String)], replayed: bool) {
    let mut seen = Vec::<&str>::new();
    for (action, _) in outbound {
        if progress.contains(action) && !seen.contains(&action.as_str()) {
            seen.push(action);
        }
    }
    assert_eq!(seen, progress, "progress lost or reordered");
    if !replayed {
        let records = outbound.iter().filter(|(a, _)| progress.contains(a));
        assert_eq!(records.count(), progress.len(), "progress duplicated");
    }
}

fn assert_final_after_progress(progress: &[String], outbound: &[(String, String)]) {
    let finals: Vec<usize> = outbound
        .iter()
        .enumerate()
        .filter(|(_, (_, kind))| kind == "final_result")
        .map(|(index, _)| index)
        .collect();
    assert_eq!(finals.len(), 1, "{outbound:?}");
    let last = outbound
        .iter()
        .rposition(|(action, _)| progress.contains(action))
        .unwrap();
    assert!(last < finals[0], "progress trails the final delivery");
}

async fn read_rows(s: &Scenario, turn: &str) -> Result<usize, HarnessError> {
    let rows = tool_rows(&s.gw.messages("general").await?, turn);
    Ok(rows
        .iter()
        .filter(|row| row["safe_tool_name"] == "read_file")
        .count())
}

async fn wait_until(
    s: &Scenario,
    what: &str,
    ready: impl Fn() -> bool,
) -> Result<(), HarnessError> {
    let started = Instant::now();
    while !ready() {
        if started.elapsed() > Duration::from_secs(20) {
            return Err(HarnessError(format!(
                "{what} not reached\n{}",
                s.agent.logs()
            )));
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    Ok(())
}

fn now_us() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros()
}
