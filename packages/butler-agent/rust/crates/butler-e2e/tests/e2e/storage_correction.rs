//! CORR-01: correction, byte-exact replay, crash recovery, queue drain and idle.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test assertions")]
use super::storage_correction_seed as seed;
mod matrix;
mod stub;
use super::data_perf::wal;
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    gateway::turn_state,
    scenario::{Access, Setup, accepted_turn_id},
};
use notify::{RecursiveMode, Watcher};
use rusqlite::Connection;
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

#[tokio::test]
async fn storage_correction_corr_01() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("CORR-01")?;
    let (url, script, server) = stub::start(setup.sandbox.workspace.display().to_string()).await?;
    let mut s = setup
        .access(Access::FullAccess)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", url)
        .env("BUTLER_E2E_STARTUP_TRACE", "1")
        .start()
        .await?;
    let id = accepted_turn_id(&s.gw.say("general", stub::REQUEST).await?)?;
    tokio::time::timeout(Duration::from_secs(30), script.held.notified())
        .await
        .map_err(|e| butler_e2e::e2e::harness_error(e.to_string()))?;
    let held = script.requests.lock().unwrap().last().unwrap()["input"].to_string();
    s.agent.kill9()?;
    let path = s.sandbox.data.join("agent-runtime/btcc.sqlite");
    let active = seed::admitted(&path, &id)?;
    assert_eq!(active.len(), 3);
    let turn = id.clone();
    let snapshot = offline(&path, move |path| {
        seed::seed(path, &seed::Profile::small(), &turn)?;
        seed::snapshot(path)
    })
    .await?;
    let baseline = s.sandbox.root.join("legacy.sqlite");
    std::fs::copy(&path, &baseline)?;
    let events = Arc::new(Mutex::new(vec![]));
    let sink = events.clone();
    let watched = path.clone();
    let missing = Arc::new(AtomicBool::new(false));
    let absent = missing.clone();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if !watched.exists() {
            absent.store(true, Ordering::SeqCst);
        }
        if let Ok(event) = event {
            sink.lock().unwrap().push(event);
        }
    })
    .map_err(std::io::Error::other)?;
    watcher
        .watch(path.parent().unwrap(), RecursiveMode::NonRecursive)
        .map_err(std::io::Error::other)?;
    s.gw = s.agent.start_again().await?;
    tokio::time::timeout(Duration::from_secs(30), script.held.notified())
        .await
        .map_err(|e| butler_e2e::e2e::harness_error(e.to_string()))?;
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
    assert_eq!(
        script.requests.lock().unwrap().last().unwrap()["input"].to_string(),
        held
    );
    assert_eq!(
        script.requests.lock().unwrap().len(),
        5,
        "rounds 1–3 were requested again"
    );
    for session in 0..120 {
        let view =
            s.gw.get(&format!("/session-view?session_id=corr-chat-{session}"))
                .await?;
        assert_eq!(view.status, 200);
        assert_eq!(view.data()["messages"].as_array().unwrap().len(), 1);
        assert_eq!(view.data()["messages"][0]["text"], "Synthetic history");
    }
    script.hold.store(false, Ordering::SeqCst);
    script.release.notify_waiters();
    let done =
        s.gw.wait_terminal("general", &id, Duration::from_secs(30))
            .await?;
    assert_eq!(turn_state(&done), "delivered");
    let queued: u64 = Connection::open(&path)?.query_row(
        "SELECT count(*) FROM agent_acceptance_reclaims",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(queued, 1);
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
    assert!(s.agent.logs().contains("step=reclaim_chunk turns=1"));
    assert!(
        s.agent
            .logs()
            .contains("phase=storage_correction outcome=noop")
    );
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
    assert!(s.agent.logs().contains("outcome=noop"));
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
        if point == "after_rename" {
            // Before normal open changes owners/claims, compare EVERY table.
            let after = offline(&path, seed::snapshot).await?;
            assert_eq!(after, snapshot, "offline correction changed durable data");
            assert_eq!(seed::admitted(&path, &id)?, active);
        }
        s.agent.launch.remove_env("BUTLER_E2E_ABORT_POINT");
        // Freeze the resumed turn so all pre-upgrade acceptances can be compared.
        script.hold.store(true, Ordering::SeqCst);
        s.gw = s.agent.start_again().await?;
        check(&path, 480, &id, &active, &snapshot).await?;
        s.agent.kill9()?;
    }
    restore(&path, &baseline)?;
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
    assert_eq!(
        std::fs::metadata(&path)?.len(),
        std::fs::metadata(&baseline)?.len()
    );
    s.agent.kill9()?;
    let pending_bytes = std::fs::metadata(&path)?.len();
    // Repeated deferral must leave the original allocation intact.
    s.gw = s.agent.start_again().await?;
    s.agent.kill9()?;
    // Normal open registers an owner, but performs no copy or replacement.
    assert_eq!(std::fs::metadata(&path)?.len(), pending_bytes);
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
        !events
            .lock()
            .unwrap()
            .iter()
            .any(|event| matches!(event.kind, notify::EventKind::Remove(_))
                && event.paths.contains(&path)),
        "btcc.sqlite was removed instead of atomically replaced"
    );
    s.finish().await?;
    server.abort();
    Ok(())
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
