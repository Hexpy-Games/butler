//! SVC-09 — the control endpoint's `service_stop` (how a stop reaches an
//! instance on hosts without stop signals; SIGTERM elsewhere) obeys the
//! same rule as SIGTERM: only a stop the controller announced in the DATA
//! stop intent, and only with the instance's control token.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::time::{Duration, Instant};

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::scenario::Setup;
use butler_e2e::e2e::stop_intent::{control_command, instance_record, intent_path};
use serde_json::json;

#[tokio::test]
async fn svc_09_service_stop_needs_the_token_and_the_announcement() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("SVC-09")?.start().await?;
    let data = s.sandbox.data.clone();
    let deadline = Instant::now() + Duration::from_secs(30);
    let record = loop {
        if let Some(record) = instance_record(&data).filter(|record| record["state"] == "ready") {
            break record;
        }
        assert!(Instant::now() < deadline, "no ready instance record");
        tokio::time::sleep(Duration::from_millis(50)).await;
    };

    let wrong = control_command(&record, "service_stop", Some("not-the-token"))?;
    assert_ne!(wrong["result"]["ok"], true, "{wrong}");
    let unannounced = control_command(&record, "service_stop", None)?;
    assert_eq!(
        unannounced["result"]["error"]["code"], "service_stop_unannounced",
        "{unannounced}"
    );
    assert!(s.gw.healthy().await, "a refused stop stopped the service");

    std::fs::write(
        intent_path(&data),
        json!({
            "schema": "butler.agent-stop-intent.v1", "reason": "stop", "requested_by": "cli",
            "respawn_by": null, "instance_id": record["nonce"], "pid": record["pid"],
            "requested_at": "2026-09-29T00:00:00.000Z",
        })
        .to_string(),
    )?;
    let accepted = control_command(&record, "service_stop", None)?;
    assert_eq!(accepted["result"]["ok"], true, "{accepted}");
    let deadline = Instant::now() + Duration::from_secs(30);
    while s.agent.is_running() {
        assert!(Instant::now() < deadline, "the announced stop did not stop");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let status = s.agent.reap().expect("the stopped agent is collected");
    assert!(status.success(), "a requested stop must exit 0: {status}");
    s.finish().await
}

#[tokio::test]
async fn stop_reads_a_complete_record_during_replacement() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut setup = Setup::new("STOP-RECORD-REPLACE")?;
    let probe = setup.sandbox.root.join("sharing-probe");
    std::fs::write(&probe, b"probe")?;
    let native = butler_platform::secure_fs::fixture_locks::deny_read(&probe)?.is_some();
    if !native {
        setup.sandbox.mark_success();
    }
    butler_e2e::skip_unless!(native, "Native read sharing required");
    let mut failures = Vec::new();
    for attempt in 0..20 {
        let pending = attempt >= 10;
        let s = Setup::new(&format!("STOP-RECORD-REPLACE-{attempt}"))?
            .start()
            .await?;
        let path = s
            .sandbox
            .data
            .join("state/butler-agent-native-service.json");
        let bytes = std::fs::read(&path)?;
        let record: serde_json::Value = serde_json::from_slice(&bytes)?;
        assert_eq!(record["state"], "ready");
        let staged = path.with_extension("replacement");
        std::fs::write(&staged, &bytes)?;
        let held = if pending {
            butler_platform::secure_fs::fixture_locks::pending_delete(&path)?
        } else {
            butler_platform::secure_fs::fixture_locks::deny_read(&path)?
        };
        assert!(held.is_some());
        assert_eq!(
            std::fs::read(&path).unwrap_err().raw_os_error(),
            Some(if pending { 5 } else { 32 })
        );
        // A short native sharing conflict during publication, with no partial
        // writes. The CLI must reopen the whole replacement after it clears.
        let writer = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(500));
            drop(held);
            butler_platform::secure_fs::rename(&staged, &path)?;
            std::io::Result::Ok(())
        });
        let stop = s.agent.cli_async(&["stop", "--json"]).await?;
        writer.join().expect("record writer panicked")?;
        if stop.code == Some(0) {
            let result: serde_json::Value = serde_json::from_str(&stop.stdout)?;
            assert_eq!(result["data"]["stopped"], true, "{result}");
            assert_eq!(result["data"]["pid"], record["pid"], "{result}");
            let stopped = s.agent.cli_async(&["stop", "--json"]).await?;
            assert_eq!(
                stopped.code,
                Some(0),
                "{} {}",
                stopped.stdout,
                stopped.stderr
            );
            let stopped: serde_json::Value = serde_json::from_str(&stopped.stdout)?;
            assert_eq!(stopped["data"]["alreadyStopped"], true, "{stopped}");
        } else {
            failures.push(format!("{attempt}: {} {}", stop.stdout, stop.stderr));
        }
        s.finish().await?;
    }
    eprintln!(
        "stop record reads: {} of 20 failed: {failures:?}",
        failures.len()
    );
    assert!(
        failures.is_empty(),
        "stop must survive record replacement: {failures:?}"
    );
    setup.sandbox.mark_success();
    Ok(())
}

#[tokio::test]
async fn record_read_preserves_real_permission_denial() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut setup = Setup::new("RECORD-READ-DENIED")?;
    let path = setup.sandbox.root.join("private-record");
    std::fs::write(&path, b"whole record")?;
    let result =
        butler_platform::secure_fs::fixture_locks::with_read_denied(&path, |delete_pending| {
            assert!(
                !delete_pending,
                "real ACL denial was classified as delete-pending"
            );
            assert_eq!(std::fs::read(&path).unwrap_err().raw_os_error(), Some(5));
            let start = Instant::now();
            let error = butler_platform::secure_fs::read_replaced_file(&path).unwrap_err();
            assert_eq!(error.raw_os_error(), Some(5));
            eprintln!("real ACL denial returned in {:?}", start.elapsed());
        })?;
    if result.is_none() {
        setup.sandbox.mark_success();
    }
    butler_e2e::skip_unless!(result.is_some(), "Native file DACL required");
    assert_eq!(
        butler_platform::secure_fs::read_replaced_file(&path)?,
        b"whole record"
    );
    setup.sandbox.mark_success();
    Ok(())
}
