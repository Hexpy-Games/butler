//! CORR-01: correction, interrupted-turn preservation, crash recovery, queue drain and idle.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test assertions")]
use super::storage_correction_seed as seed;
mod matrix;
mod presence;
mod startup;
mod stub;
use super::data_perf::wal;
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    gateway::turn_state,
    scenario::{Access, Setup},
};
use butler_platform::secure_fs;
use notify::{RecursiveMode, Watcher};
use rusqlite::Connection;
use std::{
    sync::{Arc, Mutex, atomic::Ordering},
    time::Duration,
};

#[tokio::test]
async fn storage_correction_corr_01() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = fault_setup("CORR-01")?;
    let (url, script, server) = stub::start(setup.sandbox.workspace.display().to_string()).await?;
    let mut s = setup
        .access(Access::FullAccess)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"))
        .env("BUTLER_STARTUP_TRACE", "1")
        .start()
        .await?;
    let id = s.gw.say_turn("general", stub::REQUEST).await?;
    tokio::time::timeout(Duration::from_secs(30), script.held.notified())
        .await
        .map_err(|e| butler_e2e::e2e::harness_error(e.to_string()))?;
    let requests = script.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 4);
    let path = s.sandbox.data.join("agent-runtime/btcc.sqlite");
    wait_published(&path).await?;
    s.agent.kill9()?;
    let active = seed::admitted(&path, &id)?;
    assert_eq!(active.len(), 3);
    let snapshot = offline(&path, move |path| {
        seed::seed(path, &seed::Profile::small())?;
        seed::snapshot(path)
    })
    .await?;
    let baseline = s.sandbox.root.join("legacy.sqlite");
    std::fs::copy(&path, &baseline)?;
    let events = Arc::new(Mutex::new(vec![]));
    let sink = events.clone();
    let watched = path.clone();
    let presence = presence::Presence::watch(&path);
    let missing = presence.flag();
    let absent = missing.clone();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if !watched.exists() {
            absent.store(true, Ordering::SeqCst);
        }
        // Opens/closes (including WAL sampling) are access notifications, not file changes.
        if let Ok(event) = event
            && !matches!(event.kind, notify::EventKind::Access(_))
        {
            sink.lock().unwrap().push(event);
        }
    })
    .map_err(std::io::Error::other)?;
    watcher
        .watch(path.parent().unwrap(), RecursiveMode::NonRecursive)
        .map_err(std::io::Error::other)?;
    s.gw = s.agent.start_again().await?;
    check(&path, 480, &id, &active, &snapshot).await?;
    assert!(
        !path
            .parent()
            .unwrap()
            .join("storage-correction.json")
            .exists()
    );
    assert!(
        events
            .lock()
            .unwrap()
            .iter()
            .flat_map(|e| &e.paths)
            .any(|p| p
                .file_name()
                .is_some_and(|n| n == "storage-correction.json"))
    );
    assert_eq!(script.requests.lock().unwrap().as_slice(), requests);
    assert_eq!(payload_states(&path, &id)?, [0, 0, 0]);
    for session in 0..120 {
        let view =
            s.gw.get(&format!("/session-view?session_id=corr-chat-{session}"))
                .await?;
        assert_eq!(view.status, 200);
        assert_eq!(view.data()["messages"].as_array().unwrap().len(), 1);
        assert_eq!(view.data()["messages"][0]["text"], "Synthetic history");
    }
    let done =
        s.gw.wait_terminal("general", &id, Duration::from_secs(30))
            .await?;
    assert_eq!(turn_state(&done), "failed");
    assert_eq!(done["safe_error_code"], "turn_interrupted");
    assert_eq!(done["retryable"], true);
    assert_eq!(script.requests.lock().unwrap().as_slice(), requests);
    assert_eq!(seed::admitted(&path, &id)?, active);
    // Reporting preserves retry state; fixture settlement exercises the reclaim trigger.
    assert_eq!(Connection::open(&path)?.execute(
        "UPDATE btcc_turns SET semantic_state='cancelled' WHERE turn_id=?1 AND semantic_state='admitted'",
        [&id],
    )?, 1);
    let queued: u64 = Connection::open(&path)?.query_row(
        "SELECT count(*) FROM agent_acceptance_reclaims",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(queued, 1);
    assert_eq!(
        Connection::open(&path)?.query_row(
            "SELECT turn_id FROM agent_acceptance_reclaims",
            [],
            |r| r.get::<_, String>(0)
        )?,
        id
    );
    let settled_snapshot = offline(&path, seed::snapshot).await?;
    s.agent.terminate().await?;
    events.lock().unwrap().clear();
    s.gw = s.agent.start_again().await?;
    assert!(
        !events
            .lock()
            .unwrap()
            .iter()
            .flat_map(|e| &e.paths)
            .any(|p| p
                .file_name()
                .is_some_and(|n| n == "storage-correction.json"))
    );
    let drain_trace = std::fs::read_to_string(s.agent.launch.logs.join("agent-3.log"))?;
    assert!(drain_trace.contains("step=reclaim_chunk turns=1"));
    assert_eq!(payload_states(&path, &id)?, [2, 2, 2]);
    assert_eq!(seed::admitted(&path, &id)?, ["{}", "{}", "{}"]);
    let after = offline(&path, seed::snapshot).await?;
    assert_snapshot(&settled_snapshot, &after);
    assert_eq!(script.requests.lock().unwrap().as_slice(), requests);
    assert!(drain_trace.contains("phase=storage_correction outcome=noop"));
    assert_eq!(
        Connection::open(&path)?.query_row(
            "SELECT count(*) FROM agent_acceptance_reclaims",
            [],
            |r| r.get::<_, u64>(0)
        )?,
        0
    );
    s.agent.terminate().await?;
    s.gw = s.agent.start_again().await?;
    let idle_trace = std::fs::read_to_string(s.agent.launch.logs.join("agent-4.log"))?;
    assert!(idle_trace.contains("phase=storage_correction outcome=noop"));
    assert!(!idle_trace.contains("step=reclaim_chunk"));
    assert_eq!(
        Connection::open(&path)?.query_row(
            "SELECT count(*) FROM agent_acceptance_reclaims",
            [],
            |r| r.get::<_, u64>(0)
        )?,
        0
    );
    tokio::time::sleep(Duration::from_secs(2)).await;
    let pinned = wal::Wal::pin(&s.sandbox.data, "agent-runtime/btcc.sqlite")?;
    let before = pinned.sample()?;
    events.lock().unwrap().clear();
    tokio::time::sleep(Duration::from_secs(30)).await;
    assert_eq!(pinned.delta(before)?, (0, 0));
    assert!(events.lock().unwrap().is_empty(), "idle BTCC file changes");
    drop(pinned);
    s.agent.terminate().await?;
    for point in [
        "reclaim_chunk",
        "before_vacuum",
        "after_tmp_marked",
        "after_link",
        "after_rename",
    ] {
        restore(&path, &baseline)?;
        s.agent.launch.set_env("BUTLER_E2E_ABORT_POINT", point);
        assert!(
            s.agent.start_again().await.is_err(),
            "did not abort at {point}"
        );
        s.agent.reap();
        assert!(path.exists());
        if point == "reclaim_chunk" {
            matrix::assert_reclaim_rolled_back(&path)?;
        }
        if point == "after_rename" {
            // Before normal open changes owners/claims, compare EVERY table.
            let after = offline(&path, seed::snapshot).await?;
            assert_eq!(after, snapshot, "offline correction changed durable data");
            assert_eq!(seed::admitted(&path, &id)?, active);
        }
        s.agent.launch.remove_env("BUTLER_E2E_ABORT_POINT");
        // Restored BTCC acceptances remain admitted; the App turn is already settled.
        s.gw = s.agent.start_again().await?;
        check(&path, 480, &id, &active, &snapshot).await?;
        s.agent.kill9()?;
    }
    restore(&path, &baseline)?;
    // Identity and preserved data prove deferral avoids replacement despite normal-open writes.
    let original = secure_fs::identity(&std::fs::metadata(&path)?).id;
    s.agent
        .launch
        .set_env("BUTLER_E2E_DISK_AVAILABLE_BYTES", "1");
    s.gw = s.agent.start_again().await?;
    assert_eq!(
        Connection::open(&path)?.query_row(
            "SELECT state FROM agent_storage_corrections",
            [],
            |r| r.get::<_, String>(0)
        )?,
        "pending_space"
    );
    assert_eq!(seed::admitted(&path, &id)?, active);
    assert_eq!(secure_fs::identity(&std::fs::metadata(&path)?).id, original);
    assert_snapshot(&snapshot, &offline(&path, seed::snapshot).await?);
    s.agent.kill9()?;
    // Repeated deferral preserves the original file and its admitted payloads.
    s.gw = s.agent.start_again().await?;
    s.agent.kill9()?;
    assert_eq!(secure_fs::identity(&std::fs::metadata(&path)?).id, original);
    assert_eq!(seed::admitted(&path, &id)?, active);
    assert_snapshot(&snapshot, &offline(&path, seed::snapshot).await?);
    s.agent.launch.remove_env("BUTLER_E2E_DISK_AVAILABLE_BYTES");
    s.gw = s.agent.start_again().await?;
    check(&path, 480, &id, &active, &snapshot).await?;
    script.hold.store(false, Ordering::SeqCst);
    script.release.notify_waiters();
    s.gw.wait_terminal("general", &id, Duration::from_secs(30))
        .await?;
    drop(watcher);
    assert!(
        !missing.load(Ordering::SeqCst),
        "btcc.sqlite was absent during startup"
    );
    assert!(
        !presence.was_absent(),
        "btcc.sqlite stopped resolving during startup"
    );
    assert!(
        !presence::REMOVE_EVENT_MEANS_ABSENT
            || !events
                .lock()
                .unwrap()
                .iter()
                .any(|event| matches!(event.kind, notify::EventKind::Remove(_))
                    && event.paths.contains(&path)),
        "btcc.sqlite was removed instead of atomically replaced"
    );
    drop(presence);
    s.finish().await?;
    server.abort();
    Ok(())
}

/// Fault scenarios need debug hooks even when perf CI supplies a release Agent.
fn fault_setup(id: &str) -> Result<Setup, HarnessError> {
    let setup = if std::env::var_os("BUTLER_E2E_FAULT_BIN").is_some() {
        Setup::mutates_installation(id)?
    } else {
        Setup::new(id)?
    };
    if let Some(binary) = std::env::var_os("BUTLER_E2E_FAULT_BIN") {
        butler_e2e::e2e::executable::copy(std::path::Path::new(&binary), &setup.sandbox.binary)?;
    }
    Ok(setup)
}

pub(super) fn assert_snapshot(
    before: &std::collections::BTreeMap<String, (u64, String)>,
    after: &std::collections::BTreeMap<String, (u64, String)>,
) {
    for (table, value) in before {
        // The normal open registers a new process owner and reconciles its
        // exact claims; these runtime transitions are independently expected.
        if matches!(
            table.as_str(),
            "btcc_runtime_owners" | "btcc_state_claims" | "btcc_checkpoints" | "btcc_turns"
        ) {
            continue;
        }
        assert_eq!(after.get(table), Some(value), "table changed: {table}");
    }
}
pub(super) fn restore(
    path: &std::path::Path,
    baseline: &std::path::Path,
) -> Result<(), HarnessError> {
    for suffix in [
        "sqlite-wal",
        "sqlite-shm",
        "sqlite.compact-tmp",
        "sqlite.precompact",
        "sqlite.verified",
    ] {
        let _ = std::fs::remove_file(path.with_extension(suffix));
    }
    std::fs::copy(baseline, path)?;
    Ok(())
}

/// Large fixture I/O belongs on a blocking worker, not the stub's Tokio worker.
pub(super) async fn offline<T: Send + 'static>(
    path: &std::path::Path,
    work: impl FnOnce(&std::path::Path) -> Result<T, HarnessError> + Send + 'static,
) -> Result<T, HarnessError> {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || work(&path))
        .await
        .map_err(|error| butler_e2e::e2e::harness_error(error.to_string()))?
}

async fn check(
    path: &std::path::Path,
    settled: usize,
    id: &str,
    active: &[String],
    snapshot: &std::collections::BTreeMap<String, (u64, String)>,
) -> Result<(), HarnessError> {
    let turn = id.to_owned();
    let active = active.to_vec();
    let after = offline(path, move |path| {
        seed::assert_correct(path, settled, &turn, &active)?;
        assert!(std::fs::metadata(path)?.len() as f64 <= seed::live_bytes(path)? as f64 * 1.2);
        seed::snapshot(path)
    })
    .await?;
    assert_snapshot(snapshot, &after);
    Ok(())
}

fn payload_states(path: &std::path::Path, id: &str) -> Result<Vec<u32>, HarnessError> {
    let db = Connection::open(path)?;
    Ok(db.prepare("SELECT payload_state FROM btcc_model_round_acceptances WHERE turn_id=?1 ORDER BY rowid")?
        .query_map([id], |r| r.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

async fn wait_published(path: &std::path::Path) -> Result<(), HarnessError> {
    // Finish normal progress publication before taking the correction-only snapshot.
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let pending = offline(path, |path| {
                Ok(Connection::open(path)?.query_row(
                    "SELECT EXISTS(SELECT 1 FROM btcc_progress_events WHERE status='pending')",
                    [],
                    |r| r.get::<_, bool>(0),
                )?)
            })
            .await?;
            if !pending {
                return Ok::<_, HarnessError>(());
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .map_err(|e| butler_e2e::e2e::harness_error(e.to_string()))?
}
