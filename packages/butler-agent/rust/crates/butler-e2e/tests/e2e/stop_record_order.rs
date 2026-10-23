//! `butler stop` and `butler status` read DATA ownership (the DATA lock and
//! the instance record) only between transitions: a stop that arrives while
//! the service takes or gives up DATA waits for it, then stops it, and never
//! reports a DATA lock without a record.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::fs::{self, File};
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use butler_e2e::e2e::agent::{CliOutput, read_all};
use butler_e2e::e2e::scenario::{Scenario, Setup};
use butler_e2e::e2e::stop_intent::instance_record;
use butler_e2e::e2e::{HarnessError, executable};

// test-category: race
#[tokio::test]
async fn concurrent_status_and_stop_never_see_a_phantom_owner() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("STOP-PROBE-RACE")?.start().await?;
    s.agent.terminate().await?;
    let done = AtomicBool::new(false);
    let launch = &s.agent.launch;
    let misreports = std::thread::scope(|scope| {
        // Status probes the DATA lock while each stop probes it too; neither
        // may take the other's probe for an owner.
        let readers: Vec<_> = (0..4)
            .map(|_| {
                scope.spawn(|| {
                    let mut misreports = Vec::new();
                    while !done.load(Ordering::Acquire) {
                        let mut command = launch.command();
                        command.args(["status", "--json"]).stdin(Stdio::null());
                        let output = executable::output(&mut command).unwrap();
                        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
                        let status: serde_json::Value = serde_json::from_str(stdout.trim())
                            .unwrap_or_else(|error| {
                                panic!("status is not JSON ({error}): {stdout}")
                            });
                        if status["data"]["services"]["summary"]["offline"] != 1 {
                            misreports.push(stdout);
                        }
                    }
                    misreports
                })
            })
            .collect();
        let mut misreports = Vec::new();
        for _ in 0..25 {
            let mut command = launch.command();
            command.args(["stop", "--json"]).stdin(Stdio::null());
            let output = executable::output(&mut command).unwrap();
            let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
            let stopped = serde_json::from_str::<serde_json::Value>(stdout.trim())
                .is_ok_and(|stop| stop["data"]["alreadyStopped"] == true);
            if output.status.code() != Some(0) || !stopped {
                misreports.push(format!(
                    "stop: {stdout} {}",
                    String::from_utf8_lossy(&output.stderr)
                ));
            }
        }
        done.store(true, Ordering::Release);
        for reader in readers {
            misreports.extend(reader.join().expect("status reader panicked"));
        }
        misreports
    });
    assert!(
        misreports.is_empty(),
        "a probe was taken for an owner: {misreports:?}"
    );
    s.finish().await
}

// These scenarios require hooks compiled into the target executable.
mod requires_e2e_fixtures {
    use super::*;

    #[tokio::test]
    async fn stop_waits_while_shutdown_unlocks_data() -> Result<(), HarnessError> {
        butler_e2e::gate!();
        let setup = Setup::new("STOP-HOLD-RELEASE")?;
        let release = setup.sandbox.root.join("record-hold-release");
        let mut s = held(setup, "release", &release).start().await?;
        let pid = s.agent.pid().unwrap();
        let stop = stop_while_held(&mut s, "release", &release).await?;
        assert_stopped(&s, &stop, pid);
        assert!(
            !s.agent.logs().contains("stop deadline reached"),
            "shutdown reached its deadline: {}",
            s.agent.logs()
        );
        s.finish().await
    }

    #[tokio::test]
    async fn stop_waits_while_the_deadline_unlocks_data() -> Result<(), HarnessError> {
        butler_e2e::gate!();
        let setup = Setup::new("STOP-HOLD-DEADLINE")?;
        let release = setup.sandbox.root.join("record-hold-release");
        let (mut s, _turn) =
            crate::shutdown_order::streaming_with_setup(held(setup, "deadline", &release)).await?;
        let pid = s.agent.pid().unwrap();
        // The streamed turn cannot settle while storage is locked, so only the
        // shutdown deadline ends the service.
        let db = butler_platform::sqlite::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))
            .map_err(|e| HarnessError(e.to_string()))?;
        db.execute_batch("BEGIN IMMEDIATE")
            .map_err(|e| HarnessError(e.to_string()))?;
        let stop = stop_while_held(&mut s, "deadline", &release).await;
        db.execute_batch("ROLLBACK")
            .map_err(|e| HarnessError(e.to_string()))?;
        drop(db);
        assert_stopped(&s, &stop?, pid);
        assert!(
            s.agent.logs().contains("stop deadline reached"),
            "storage did not hold shutdown until its deadline: {}",
            s.agent.logs()
        );
        s.finish().await
    }

    #[tokio::test]
    async fn stop_waits_while_startup_publishes_its_record() -> Result<(), HarnessError> {
        butler_e2e::gate!();
        let setup = Setup::new("STOP-HOLD-STARTUP")?;
        let release = setup.sandbox.root.join("record-hold-release");
        let mut s = setup.start().await?;
        s.agent.terminate().await?;
        s.agent.launch.set_env("BUTLER_E2E_RECORD_HOLD", "startup");
        s.agent
            .launch
            .set_env("BUTLER_E2E_RECORD_HOLD_RELEASE", release.to_string_lossy());
        let pid = s.agent.start_process()?;
        // The stop arrives once startup has taken DATA and not yet published.
        let reached = hold_reached("startup");
        let deadline = Instant::now() + Duration::from_secs(60);
        while !s.agent.logs().contains(&reached) {
            assert!(Instant::now() < deadline, "startup never reached its hold");
            assert!(s.agent.is_running(), "startup exited before its hold");
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        let stop = stop_while_held(&mut s, "startup", &release).await?;
        assert_stopped(&s, &stop, pid);
        s.finish().await
    }
}

fn held(setup: Setup, point: &str, release: &Path) -> Setup {
    setup
        .env("BUTLER_E2E_RECORD_HOLD", point)
        .env("BUTLER_E2E_RECORD_HOLD_RELEASE", release.to_string_lossy())
}

/// Runs `butler stop --json` while the service is held at `point`, and lets
/// the service go on only once the stop is waiting to observe DATA.
async fn stop_while_held(
    s: &mut Scenario,
    point: &str,
    release: &Path,
) -> Result<CliOutput, HarnessError> {
    let dir = s.sandbox.root.join(format!("held-stop-{point}"));
    fs::create_dir_all(&dir)?;
    let (stdout, stderr) = (dir.join("stdout"), dir.join("stderr"));
    let mut command = s.agent.launch.command();
    command
        .args(["stop", "--json"])
        .stdin(Stdio::null())
        .stdout(File::create(&stdout)?)
        .stderr(File::create(&stderr)?);
    let logs = s.agent.launch.logs.clone();
    let reached = hold_reached(point);
    let hang = Instant::now() + Duration::from_secs(60);
    let mut waited = false;
    let mut released = false;
    let status = s
        .agent
        .while_reaping(
            move || executable::status(&mut command),
            || {
                if released {
                    return;
                }
                let cli = fs::read_to_string(&stderr).unwrap_or_default();
                waited = read_all(&logs).contains(&reached) && observing(&cli);
                if waited || Instant::now() > hang {
                    fs::write(release, b"release").expect("hold release is written");
                    released = true;
                }
            },
        )
        .await??;
    assert!(waited, "the stop never waited on the held transition");
    Ok(CliOutput {
        code: status.code(),
        stdout: fs::read_to_string(dir.join("stdout")).unwrap_or_default(),
        stderr: fs::read_to_string(dir.join("stderr")).unwrap_or_default(),
    })
}

fn hold_reached(point: &str) -> String {
    format!("phase=record_hold:{point} edge=event")
}

/// The CLI began an observation of DATA and has not finished it.
fn observing(cli: &str) -> bool {
    let edge = |edge: &str| {
        cli.matches(&format!("phase=instance_observe_wait edge={edge}"))
            .count()
    };
    edge("begin") > edge("end")
}

fn assert_stopped(s: &Scenario, stop: &CliOutput, pid: u32) {
    assert_eq!(stop.code, Some(0), "{stop:?}");
    let result = stop.json().expect("stop result is JSON");
    assert_eq!(result["data"]["stopped"], true, "{result}");
    assert_eq!(result["data"]["pid"], pid, "{result}");
    assert!(
        instance_record(&s.sandbox.data).is_none(),
        "the stopped service left its record"
    );
    let status = s
        .agent
        .exit_status(pid)
        .expect("the stopped service was reaped");
    assert!(status.success(), "a requested stop must exit 0: {status}");
}
