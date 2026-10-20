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
            if pending {
                // A delete-on-close replacement has a real missing-entry
                // interval. Outlast a read retry so it must observe the gap.
                std::thread::sleep(Duration::from_millis(100));
            }
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
    let missing = Instant::now();
    assert_eq!(
        butler_platform::secure_fs::read_replaced_file(&path)
            .unwrap_err()
            .kind(),
        std::io::ErrorKind::NotFound
    );
    eprintln!("initial missing record returned in {:?}", missing.elapsed());
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

#[tokio::test]
async fn stop_identity_unavailable_requires_observed_exit() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for (operation, skip) in [
        ("start", 0),
        ("executable", 0),
        ("start", 1),
        ("executable", 1),
    ] {
        for exited in [false, true] {
            let mut s = Setup::new(&format!("STOP-IDENTITY-{operation}-{skip}-{exited}"))?
                .start()
                .await?;
            let barrier = s.sandbox.root.join("identity-barrier");
            std::fs::create_dir(&barrier)?;
            let pid = s.agent.pid().expect("running service PID");
            std::fs::write(barrier.join("target"), format!("{pid}:{operation}:{skip}"))?;
            let mut launch = s.agent.launch.clone();
            launch.set_env("BUTLER_E2E_IDENTITY_BARRIER", barrier.to_string_lossy());
            let mut command = tokio::process::Command::from(launch.command());
            command
                .args(["stop", "--json"])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .kill_on_drop(true);
            let cli = command.spawn()?;
            let deadline = Instant::now() + Duration::from_secs(30);
            while !barrier.join("reached").exists() {
                assert!(
                    Instant::now() < deadline,
                    "CLI did not probe the recorded PID"
                );
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            if exited {
                // Stop through the control endpoint without contending for
                // the admission lock held by the paused CLI.
                let record = instance_record(&s.sandbox.data).expect("record read before probe");
                std::fs::write(intent_path(&s.sandbox.data), json!({
                    "schema": "butler.agent-stop-intent.v1", "reason": "stop", "requested_by": "cli",
                    "respawn_by": null, "instance_id": record["nonce"], "pid": record["pid"],
                    "requested_at": "2026-10-20T00:00:00.000Z",
                }).to_string())?;
                let accepted = control_command(&record, "service_stop", None)?;
                assert_eq!(accepted["result"]["ok"], true, "{accepted}");
                while s.agent.is_running() {
                    assert!(
                        Instant::now() < deadline,
                        "service did not exit during probe"
                    );
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                assert!(s.agent.reap().expect("exited service").success());
            } else {
                assert!(s.gw.healthy().await);
            }
            std::fs::write(barrier.join("release"), b"continue")?;
            let output = cli.wait_with_output().await?;
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let payload = if output.status.success() {
                stdout.as_ref()
            } else {
                stderr.lines().last().unwrap_or("")
            };
            let value: serde_json::Value = serde_json::from_str(payload)?;
            eprintln!(
                "identity race: operation={operation} skip={skip} exited={exited} status={} {stdout} {stderr}",
                output.status
            );
            if exited {
                assert!(output.status.success(), "{stdout} {stderr}");
                if skip == 0 {
                    assert_eq!(value["data"]["alreadyStopped"], true, "{value}");
                }
                assert_eq!(value["data"]["stopped"], true, "{value}");
            } else {
                assert!(!output.status.success(), "{value}");
                assert_eq!(
                    value["error"]["message"],
                    if operation == "start" {
                        "native_service_process_identity_unavailable"
                    } else {
                        "native_service_process_executable_unavailable"
                    },
                    "{stdout} {stderr}"
                );
                assert_eq!(s.agent.pid(), Some(pid));
                assert!(s.agent.is_running(), "unverified PID was stopped");
                assert!(
                    s.gw.healthy().await,
                    "refused stop changed the live service"
                );
            }
            s.finish().await?;
        }
    }
    Ok(())
}
