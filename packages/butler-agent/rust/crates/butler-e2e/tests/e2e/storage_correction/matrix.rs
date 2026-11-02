//! Storage-only restart qualification, independent of App crash-resume policy.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test assertions")]
use super::{fault_setup, offline, seed};
use butler_e2e::e2e::HarnessError;
use butler_platform::secure_fs;
use rusqlite::Connection;
use std::time::Duration;
mod failures;
mod trace;
use trace::phase;

#[tokio::test]
async fn storage_correction_crashes_queue_and_idle() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = phase("setup/copy/initial startup", async {
        fault_setup("CORR-STORAGE")?
            .env("BUTLER_STARTUP_TRACE", "1")
            .start()
            .await
    })
    .await?;
    s.agent.terminate().await?;
    let path = s.sandbox.data.join("agent-runtime/btcc.sqlite");
    let seeded = offline(&path, |path| {
        let db = Connection::open(path)?;
        db.execute_batch("INSERT INTO btcc_inbound_inbox(inbox_id,session_id,trigger_key,turn_id,admission_input_hash,command_json,status) VALUES('corr-active','general','corr-active','corr-active','fixture','{}','constructed');
        INSERT INTO btcc_turns(turn_id,session_id,inbox_id,trigger_key,original_message_id,original_message,admission_snapshot_ref,model_selection_json,context_json,semantic_state,revision,execution_fence) VALUES('corr-active','general','corr-active','corr-active','corr-active','Synthetic admitted','fixture','{}','{}','admitted',1,1);")?;
        drop(db);
        seed::seed(path, &seed::Profile::small())?;
        // Three unclaimed but admitted Full rows, unreachable by dispatch.
        let db = Connection::open(path)?;
        db.execute("INSERT INTO btcc_model_round_acceptances(acceptance_id,turn_id,round_id,route_digest,candidate_index,checkpoint_id,checkpoint_revision,model_ref,transport_attempt,normalized_response_json,created_at) SELECT 'active-'||rowid,'corr-active','active-'||rowid,route_digest,candidate_index,checkpoint_id,checkpoint_revision,model_ref,transport_attempt,normalized_response_json,created_at FROM btcc_model_round_acceptances LIMIT 3", [])?;
        drop(db);
        Ok((seed::snapshot(path)?, seed::admitted(path, "corr-active")?))
    });
    let (snapshot, active) = phase("seed/snapshot", seeded).await?;
    let baseline = s.sandbox.root.join("legacy.sqlite");
    std::fs::copy(&path, &baseline)?;
    let (watcher, presence, missing, sidecar_events) = watch(&path)?;
    for point in [
        "reclaim_chunk",
        "before_vacuum",
        "after_tmp_marked",
        "after_link",
        "after_rename",
    ] {
        phase(&format!("{point}: restore"), async {
            super::restore(&path, &baseline)
        })
        .await?;
        s.agent.launch.set_env("BUTLER_E2E_ABORT_POINT", point);
        assert!(
            phase(&format!("{point}: abort startup"), s.agent.start_again())
                .await
                .is_err(),
            "did not abort at {point}"
        );
        phase(&format!("{point}: reap"), async {
            assert!(
                s.agent.reap().is_some_and(|status| !status.success()),
                "fault child must exit unsuccessfully"
            );
            Ok(())
        })
        .await?;
        assert!(path.exists());
        if point == "reclaim_chunk" {
            assert_reclaim_rolled_back(&path)?;
        }
        if point == "after_rename" {
            assert_eq!(offline(&path, seed::snapshot).await?, snapshot);
        }
        s.agent.launch.remove_env("BUTLER_E2E_ABORT_POINT");
        s.gw = phase(&format!("{point}: recovery startup"), s.agent.start_again()).await?;
        phase(
            &format!("{point}: verify"),
            verify(&path, &active, &snapshot),
        )
        .await?;
        s.agent.terminate().await?;
    }
    failures::exercise(&mut s, &path, &baseline, &active, &snapshot).await?;
    super::restore(&path, &baseline)?;
    // File identity and preserved data prove disk-full deferral avoids replacement despite normal-open writes.
    let original = secure_fs::identity(&std::fs::metadata(&path)?).id;
    s.agent
        .launch
        .set_env("BUTLER_E2E_DISK_AVAILABLE_BYTES", "1");
    s.gw = phase("queue/space startup", s.agent.start_again()).await?;
    assert_eq!(secure_fs::identity(&std::fs::metadata(&path)?).id, original);
    assert_eq!(state(&path)?, "pending_space");
    assert_eq!(seed::admitted(&path, "corr-active")?, active);
    s.agent.terminate().await?;
    s.agent.launch.remove_env("BUTLER_E2E_DISK_AVAILABLE_BYTES");
    s.gw = phase("queue/space startup", s.agent.start_again()).await?;
    phase("queue/space verify", verify(&path, &active, &snapshot)).await?;
    assert!(sidecar_events.load(std::sync::atomic::Ordering::SeqCst));
    for session in 0..120 {
        let view =
            s.gw.get(&format!("/session-view?session_id=corr-chat-{session}"))
                .await?;
        assert_eq!(view.status, 200);
        assert_eq!(view.data()["messages"].as_array().unwrap().len(), 1);
        assert_eq!(view.data()["messages"][0]["text"], "Synthetic history");
    }
    sidecar_events.store(false, std::sync::atomic::Ordering::SeqCst);
    // A stale queue entry must never erase admitted payload.
    Connection::open(&path)?.execute(
        "INSERT INTO agent_acceptance_reclaims VALUES('corr-active','fixture')",
        [],
    )?;
    s.agent.terminate().await?;
    s.gw = phase("queue/space startup", s.agent.start_again()).await?;
    assert_eq!(seed::admitted(&path, "corr-active")?, active);
    // Settlement queues the three rows in the same transition transaction.
    Connection::open(&path)?.execute(
        "UPDATE btcc_turns SET semantic_state='cancelled' WHERE turn_id='corr-active'",
        [],
    )?;
    s.agent.terminate().await?;
    s.gw = phase("queue/space startup", s.agent.start_again()).await?;
    assert_eq!(seed::admitted(&path, "corr-active")?, ["{}", "{}", "{}"]);
    assert!(
        !path
            .parent()
            .unwrap()
            .join("storage-correction.json")
            .exists()
    );
    assert!(!sidecar_events.load(std::sync::atomic::Ordering::SeqCst));
    s.agent.terminate().await?;
    s.gw = phase("queue/space startup", s.agent.start_again()).await?;
    phase("idle settle", async {
        tokio::time::sleep(Duration::from_secs(2)).await;
        Ok(())
    })
    .await?;
    let pinned =
        super::super::data_perf::wal::Wal::pin(&s.sandbox.data, "agent-runtime/btcc.sqlite")?;
    let before = pinned.sample()?;
    let files = offline(path.parent().unwrap(), fingerprint).await?;
    phase("idle observation", async {
        tokio::time::sleep(Duration::from_secs(30)).await;
        Ok(())
    })
    .await?;
    assert_eq!(pinned.delta(before)?, (0, 0));
    assert_eq!(offline(path.parent().unwrap(), fingerprint).await?, files);
    drop(pinned);
    drop(watcher);
    assert!(
        !presence.was_absent() && !missing.load(std::sync::atomic::Ordering::SeqCst),
        "btcc.sqlite was absent"
    );
    s.finish().await
}

pub(super) fn assert_reclaim_rolled_back(path: &std::path::Path) -> Result<(), HarnessError> {
    let db = Connection::open(path)?;
    assert_eq!(state(path)?, "reclaiming");
    assert_eq!(
        db.query_row("SELECT count(*) FROM agent_acceptance_reclaims", [], |r| {
            r.get::<_, u64>(0)
        })?,
        120
    );
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM btcc_model_round_acceptances WHERE payload_state=2",
            [],
            |r| r.get::<_, u64>(0)
        )?,
        0
    );
    Ok(())
}

fn state(path: &std::path::Path) -> Result<String, HarnessError> {
    Ok(Connection::open(path)?.query_row(
        "SELECT state FROM agent_storage_corrections",
        [],
        |r| r.get(0),
    )?)
}
async fn verify(
    path: &std::path::Path,
    active: &[String],
    before: &std::collections::BTreeMap<String, (u64, String)>,
) -> Result<(), HarnessError> {
    let active = active.to_vec();
    let after = offline(path, move |path| {
        seed::assert_correct(path, 480, "corr-active", &active)?;
        assert!(std::fs::metadata(path)?.len() as f64 <= seed::live_bytes(path)? as f64 * 1.2);
        seed::snapshot(path)
    })
    .await?;
    super::assert_snapshot(before, &after);
    Ok(())
}
fn fingerprint(
    path: &std::path::Path,
) -> Result<
    std::collections::BTreeMap<std::path::PathBuf, (u64, std::time::SystemTime)>,
    HarnessError,
> {
    std::fs::read_dir(path)?
        .map(|entry| {
            let entry = entry?;
            let m = entry.metadata()?;
            Ok((entry.path(), (m.len(), m.modified()?)))
        })
        .collect()
}

fn watch(
    path: &std::path::Path,
) -> Result<
    (
        notify::RecommendedWatcher,
        super::presence::Presence,
        std::sync::Arc<std::sync::atomic::AtomicBool>,
        std::sync::Arc<std::sync::atomic::AtomicBool>,
    ),
    HarnessError,
> {
    use notify::Watcher;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    let presence = super::presence::Presence::watch(path);
    let missing = Arc::new(AtomicBool::new(false));
    let sidecar = Arc::new(AtomicBool::new(false));
    let absent = missing.clone();
    let progress = sidecar.clone();
    let db = path.to_owned();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if !db.exists() {
            absent.store(true, Ordering::SeqCst);
        }
        if let Ok(event) = event {
            if super::presence::REMOVE_EVENT_MEANS_ABSENT
                && matches!(event.kind, notify::EventKind::Remove(_))
                && event.paths.contains(&db)
            {
                absent.store(true, Ordering::SeqCst);
            }
            if event.paths.iter().any(|p| {
                p.file_name()
                    .is_some_and(|n| n == "storage-correction.json")
            }) {
                progress.store(true, Ordering::SeqCst);
            }
        }
    })
    .map_err(std::io::Error::other)?;
    watcher
        .watch(path.parent().unwrap(), notify::RecursiveMode::NonRecursive)
        .map_err(std::io::Error::other)?;
    Ok((watcher, presence, missing, sidecar))
}

#[tokio::test]
async fn storage_progress_extends_native_startup_deadline() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = fault_setup("CORR-STARTUP-DEADLINE")?.start().await?;
    s.agent.terminate().await?;
    let path = s.sandbox.data.join("agent-runtime/btcc.sqlite");
    offline(&path, |path| seed::seed(path, &seed::Profile::small())).await?;
    let release = s.sandbox.root.join("correction-release");
    s.agent
        .launch
        .set_env("BUTLER_E2E_HOLD_POINT", "before_vacuum");
    s.agent
        .launch
        .set_env("BUTLER_E2E_HOLD_RELEASE", release.to_string_lossy());
    s.agent.start_process()?;
    let end = std::time::Instant::now() + Duration::from_secs(10);
    while !release.with_extension("held").exists() {
        assert!(s.agent.is_running(), "storage pause was not reached");
        assert!(std::time::Instant::now() < end);
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(
        path.parent()
            .unwrap()
            .join("storage-correction.json")
            .exists()
    );
    tokio::time::sleep(Duration::from_secs(91)).await;
    assert!(
        s.agent.is_running(),
        "native 90s timeout ignored storage progress"
    );
    tokio::fs::write(release, b"release").await?;
    let end = std::time::Instant::now() + Duration::from_secs(10);
    while !s.gw.healthy().await {
        assert!(
            std::time::Instant::now() < end,
            "released startup did not become ready"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    offline(&path, |path| seed::assert_correct(path, 480, "none", &[])).await?;
    s.finish().await
}

#[tokio::test]
async fn storage_correction_end_near_deadline_keeps_readiness_grace() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = fault_setup("CORR-END-DEADLINE")?.start().await?;
    s.agent.terminate().await?;
    let path = s.sandbox.data.join("agent-runtime/btcc.sqlite");
    offline(&path, |path| seed::seed(path, &seed::Profile::small())).await?;
    let release = s.sandbox.root.join("correction-release");
    s.agent
        .launch
        .set_env("BUTLER_E2E_HOLD_POINT", "before_vacuum");
    s.agent
        .launch
        .set_env("BUTLER_E2E_HOLD_RELEASE", release.to_string_lossy());
    s.agent.launch.set_env("BUTLER_E2E_HOLD_APP_STARTUP", "1");
    let started = std::time::Instant::now();
    s.agent.start_process()?;
    let end = started + Duration::from_secs(10);
    while !release.with_extension("held").exists() {
        assert!(s.agent.is_running());
        assert!(std::time::Instant::now() < end);
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let progress = path.parent().unwrap().join("storage-correction.json");
    assert!(progress.exists());
    tokio::time::sleep_until(tokio::time::Instant::from_std(
        started + Duration::from_secs(86),
    ))
    .await;
    tokio::fs::write(release, b"release").await?;
    // Correction completion is sidecar removal. App startup reaches its own
    // barrier later, after storage open and executor publication.
    let end = started + Duration::from_secs(89);
    while progress.exists() {
        assert!(s.agent.is_running(), "{}", s.agent.logs());
        assert!(
            std::time::Instant::now() < end,
            "correction must end before 90s"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    eprintln!(
        "correction completed after {}ms",
        started.elapsed().as_millis()
    );
    tokio::time::sleep_until(tokio::time::Instant::from_std(
        started + Duration::from_secs(94),
    ))
    .await;
    assert!(
        s.agent.is_running(),
        "correction end did not extend readiness"
    );
    assert!(s.sandbox.data.join("e2e-startup-held").exists());
    tokio::fs::write(s.sandbox.data.join("e2e-startup-release"), b"release").await?;
    let end = std::time::Instant::now() + Duration::from_secs(10);
    while !s.gw.healthy().await {
        assert!(std::time::Instant::now() < end);
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    offline(&path, |path| seed::assert_correct(path, 480, "none", &[])).await?;
    eprintln!(
        "correction sidecar absent before 90s; readiness reached after {}ms",
        started.elapsed().as_millis()
    );
    s.finish().await
}
