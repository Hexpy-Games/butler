//! ACC-01 real legacy provider/storage crash replay; ACC-02 authority checkpoint.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test assertions")]
mod guards;
pub(super) mod process;
pub(super) mod stub;
use butler_e2e::e2e::{HarnessError, sandbox::Sandbox, scenario::Setup};
use process::Process;
use rusqlite::Connection;
use serde_json::Value;
use std::{
    sync::{Arc, atomic::Ordering},
    time::{Duration, Instant},
};

#[tokio::test]
async fn acceptance_payload_acc_01() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut sandbox, script, server, endpoint, mut child) = held("ACC-01", 6, "write").await?;
    let path = sandbox.data.join("round-store.sqlite");
    let rows = rows(&path, "turn")?;
    assert_eq!(rows.len(), 6);
    assert_eq!(rows[0].1, 0);
    for (index, row) in rows.iter().enumerate().skip(1) {
        assert_eq!(row.1, 1);
        let value: Value = serde_json::from_str(&row.2)?;
        assert!(value["continuation"].get("statelessInput").is_none());
        let delta: Value = serde_json::from_str(row.3.as_ref().unwrap())?;
        assert_eq!(delta["v"], 1);
        assert_eq!(delta["base"], rows[index - 1].0);
        assert_eq!(
            delta
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            ["v", "base", "baseCount", "count", "ops"]
        );
        assert!(
            delta["ops"]
                .as_array()
                .unwrap()
                .iter()
                .all(|op| op.as_object().unwrap().len() == 1
                    && (op.get("c").is_some() || op.get("l").is_some()))
        );
    }
    let (resumed, replay) =
        crash_replay(&sandbox, &script, &endpoint, &mut child, "replay").await?;
    let delta_hashes = report(&sandbox, "replay")?["hashes"].clone();
    let mut resumed = resumed;
    resumed.kill9()?;
    guards::verify(&sandbox, &endpoint).await?;
    let input = script.input.lock().unwrap().clone();
    full_rows(&sandbox, "write")?;
    let mut full = Process::start(&sandbox, &endpoint, 6, "replay")?;
    process::wait(&script, &mut full).await?;
    assert_eq!(
        *script.input.lock().unwrap(),
        input,
        "Full oracle changed wire input"
    );
    assert_eq!(
        delta_hashes,
        report(&sandbox, "replay")?["hashes"],
        "load differs from Full row serialization"
    );
    eprintln!("ACC-01 replay_ms={}", replay.as_millis());
    release(&script);
    full.finish().await?;
    server.abort();
    sandbox.mark_success();
    Ok(())
}

pub(super) async fn held(
    name: &str,
    rounds: usize,
    mode: &str,
) -> Result<
    (
        Sandbox,
        Arc<stub::Script>,
        tokio::task::JoinHandle<()>,
        String,
        Process,
    ),
    HarnessError,
> {
    let sandbox = Setup::new(name)?.sandbox;
    let (endpoint, script, server) =
        stub::start(sandbox.workspace.display().to_string(), rounds).await?;
    let mut child = Process::start(&sandbox, &endpoint, rounds, mode)?;
    process::wait(&script, &mut child).await?;
    assert_eq!(
        *script.requests.lock().unwrap(),
        (0..=rounds).collect::<Vec<_>>()
    );
    Ok((sandbox, script, server, endpoint, child))
}

pub(super) async fn crash_replay(
    sandbox: &Sandbox,
    script: &Arc<stub::Script>,
    endpoint: &str,
    child: &mut Process,
    mode: &str,
) -> Result<(Process, Duration), HarnessError> {
    let before = script.input.lock().unwrap().clone();
    let count = script.requests.lock().unwrap().len();
    child.kill9()?;
    let start = Instant::now();
    let mut resumed = Process::start(sandbox, endpoint, script.rounds, mode)?;
    process::wait(script, &mut resumed).await?;
    let elapsed = start.elapsed();
    assert_eq!(
        *script.input.lock().unwrap(),
        before,
        "resend changed wire input bytes"
    );
    let requests = script.requests.lock().unwrap();
    assert_eq!(
        requests.len(),
        count + 1,
        "accepted rounds were requested again"
    );
    assert_eq!(requests.last(), Some(&script.rounds));
    Ok((resumed, elapsed))
}
pub(super) fn release(script: &stub::Script) {
    script.hold.store(false, Ordering::SeqCst);
    script.release.notify_waiters();
}
pub(super) fn report(sandbox: &Sandbox, mode: &str) -> Result<Value, HarnessError> {
    Ok(serde_json::from_slice(&std::fs::read(
        sandbox.data.join(format!("round-store.{mode}.json")),
    )?)?)
}
pub(super) type Row = (String, i64, String, Option<String>);
pub(super) fn rows(path: &std::path::Path, turn: &str) -> Result<Vec<Row>, HarnessError> {
    Ok(Connection::open(path)?.prepare("SELECT acceptance_id,payload_state,normalized_response_json,continuation_delta_json FROM btcc_model_round_acceptances WHERE turn_id=?1 ORDER BY rowid")?
        .query_map([turn], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Independent Full oracle: persist the actual accepted carrier, then use the legacy loader.
pub(super) fn full_rows(sandbox: &Sandbox, mode: &str) -> Result<(), HarnessError> {
    let report = report(sandbox, mode)?;
    let raw = report["full_rows"].as_array().unwrap();
    let path = sandbox.data.join("round-store.sqlite");
    let rows = rows(&path, "turn")?;
    let offset = rows.len() - raw.len();
    let db = Connection::open(path)?;
    for (row, full) in rows.iter().skip(offset).zip(raw) {
        assert_eq!(db.execute("UPDATE btcc_model_round_acceptances SET normalized_response_json=?1, payload_state=0, continuation_delta_json=NULL WHERE acceptance_id=?2", rusqlite::params![full.as_str().unwrap(),row.0])?, 1);
    }
    Ok(())
}

#[tokio::test]
async fn acceptance_payload_acc_02() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut sandbox, script, server, _, child) = held("ACC-02", 6, "checkpoint").await?;
    let path = sandbox.data.join("round-store.sqlite");
    let db = Connection::open(&path)?;
    let checkpoints = db.prepare("SELECT checkpoint_id,payload_state FROM btcc_model_round_acceptances WHERE turn_id='turn' ORDER BY rowid")?
        .query_map([], |r| Ok((r.get::<_, String>(0)?,r.get::<_, i64>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    assert_eq!(checkpoints.len(), 6);
    assert_eq!(checkpoints[0].1, 0);
    assert_eq!(checkpoints[1].1, 1);
    assert_ne!(checkpoints[2].0, checkpoints[0].0);
    assert_eq!(
        checkpoints[2].1, 0,
        "authority-resumed checkpoint must begin Full"
    );
    assert!(
        checkpoints[3..]
            .iter()
            .all(|row| row.0 == checkpoints[2].0 && row.1 == 1)
    );
    release(&script);
    child.finish().await?;
    server.abort();
    sandbox.mark_success();
    Ok(())
}
