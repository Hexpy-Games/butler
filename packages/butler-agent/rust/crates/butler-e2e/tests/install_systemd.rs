//! INS-14 — a real `systemd --user` job (Linux CI with a user manager only).
//!
//! The service manager belongs to the user, not to the sandbox `HOME`, so
//! this scenario runs with the real `HOME` (the unit lands in the runner's
//! `~/.config/systemd/user` and is removed at the end) and keeps everything
//! else (Agent home, data folder, `butler` command) in the sandbox. It runs
//! only when `BUTLER_E2E_SYSTEMD=1`, which the Linux CI job sets after probing
//! for a user manager; elsewhere it reports SKIPPED. It shows that stop,
//! start, restart and update keep the service under the manager: the process
//! systemd reports as the unit's `MainPID` is the process the instance
//! record names, after every one of them, and a stopped service stays
//! stopped.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

mod install_support;

use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::agent::Launch;
use butler_e2e::e2e::install_fixture::{build_archive, release_platform, write_update_manifest};
use butler_e2e::e2e::stop_intent::instance_record;
use butler_platform::service_registration::{Manager, manager};
use install_support::{ok, run, sandbox};
use serde_json::Value;

const UNIT: &str = "butler-agent.service";

fn user_manager_available() -> bool {
    std::env::var("BUTLER_E2E_SYSTEMD").as_deref() == Ok("1")
        && manager() == Manager::SystemdUser
        && Command::new("systemctl")
            .args(["--user", "show-environment"])
            .output()
            .is_ok_and(|output| output.status.success())
}

/// The process systemd runs for the unit; `None` when it runs none.
fn main_pid() -> Option<u64> {
    let output = Command::new("systemctl")
        .args(["--user", "show", "--property=MainPID", "--value", UNIT])
        .output()
        .ok()?;
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse()
        .ok()
        .filter(|pid| *pid != 0)
}

fn record(launch: &Launch) -> Option<Value> {
    instance_record(&launch.data)
}

fn ready(launch: &Launch) -> Value {
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        if let Some(record) = record(launch).filter(|record| record["state"] == "ready") {
            return record;
        }
        assert!(Instant::now() < deadline, "no ready service record");
        std::thread::sleep(Duration::from_millis(200));
    }
}

/// The unit's process is the instance the record names.
fn supervised(launch: &Launch) -> Value {
    let record = ready(launch);
    let deadline = Instant::now() + Duration::from_secs(30);
    while main_pid() != record["pid"].as_u64() {
        assert!(
            Instant::now() < deadline,
            "systemd runs {:?}, the record names {}",
            main_pid(),
            record["pid"]
        );
        std::thread::sleep(Duration::from_millis(200));
    }
    record
}

/// Stops the process without ending it, so it cannot answer a SIGTERM.
fn signal_stop(pid: u64) {
    let _ = Command::new("kill")
        .args(["-STOP", &pid.to_string()])
        .output();
}

/// Runs `butler restart` as a process of the unit's own cgroup. False when
/// this user cannot move a process there.
fn restart_from_inside_the_unit(launch: &Launch, launcher: &std::path::Path) -> bool {
    let group = Command::new("systemctl")
        .args(["--user", "show", "--property=ControlGroup", "--value", UNIT])
        .output()
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .unwrap_or_default();
    let procs = format!("/sys/fs/cgroup{group}/cgroup.procs");
    if group.is_empty() || !std::path::Path::new(&procs).exists() {
        return false;
    }
    let script = format!(
        "echo $$ > '{procs}' || exit 111; exec '{}' restart --json",
        launcher.display()
    );
    let moved = launch
        .env_command(std::path::Path::new("/bin/sh"))
        .args(["-c", &script])
        .stdin(std::process::Stdio::null())
        .output();
    // The shell that could not move exits 111 before it restarts anything.
    moved.is_ok_and(|output| output.status.code() != Some(111))
}

/// Removes the unit and stops the service when the scenario ends.
struct Cleanup(Launch, PathBuf);

impl Drop for Cleanup {
    fn drop(&mut self) {
        let _ = self
            .0
            .env_command(&self.1)
            .args(["service", "uninstall"])
            .output();
        let _ = self.0.command().args(["stop"]).output();
    }
}

#[test]
fn ins_14_a_systemd_user_job_stays_supervised() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    if !user_manager_available() {
        eprintln!("SKIPPED (no systemd --user manager, or BUTLER_E2E_SYSTEMD is not 1)");
        return Ok(());
    }
    let (sandbox, mut launch) = sandbox("INS-14")?;
    launch.use_data_folder_token();
    // The one scenario that uses the real manager says so.
    launch.set_env("BUTLER_SERVICE_MANAGER", "on");
    launch.home = butler_platform::user_dirs::home_dir().expect("HOME");
    // A data folder with a space and a non-ASCII letter reaches the unit's
    // ExecStart= and Environment= intact.
    launch.data = sandbox.root.join("d\u{e2}ta folder");
    std::fs::create_dir_all(&launch.data)?;
    for key in ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"] {
        if let Ok(value) = std::env::var(key) {
            launch.set_env(key, value);
        }
    }
    let bin = sandbox.root.join("bin");
    launch.set_env("BUTLER_BIN_DIR", bin.display().to_string());
    let fixtures = sandbox.root.join("fixtures");
    let (v1, v2) = (
        build_archive(&fixtures, "0.0.1", &sandbox.binary, &sandbox.resources)?,
        build_archive(&fixtures, "0.0.2", &sandbox.binary, &sandbox.resources)?,
    );
    let manifest = fixtures.join("update.json");
    write_update_manifest(&manifest, &[(Some(release_platform()), &v2)])?;
    launch.set_env("BUTLER_UPDATE_MANIFEST", manifest.display().to_string());
    let launcher = bin.join("butler");
    let _cleanup = Cleanup(launch.clone(), launcher.clone());
    let butler = |args: &[&str]| run(launch.env_command(&launcher).args(args));

    ok(&run(launch.command().args([
        "install",
        "--from",
        &v1.path.display().to_string(),
        "--no-restart",
        "--json",
    ]))?)?;
    ok(&butler(&["service", "install", "--json"])?)?;
    let first = supervised(&launch);

    // A stop stays a stop: the unit is not relaunched.
    ok(&butler(&["stop", "--json"])?)?;
    std::thread::sleep(Duration::from_secs(12));
    assert!(
        record(&launch).is_none(),
        "systemd relaunched a stopped service"
    );
    assert_eq!(main_pid(), None);

    // A start goes through the manager.
    ok(&butler(&["start", "--json"])?)?;
    let started = supervised(&launch);
    assert_ne!(started["nonce"], first["nonce"]);

    // So does a restart.
    ok(&butler(&["restart", "--json"])?)?;
    let restarted = supervised(&launch);
    assert_ne!(restarted["nonce"], started["nonce"]);

    // A service that ignores the polite stop is stopped through the manager,
    // not killed behind its back, and stays stopped.
    signal_stop(restarted["pid"].as_u64().unwrap());
    ok(&butler(&["stop", "--json"])?)?;
    std::thread::sleep(Duration::from_secs(12));
    assert!(record(&launch).is_none(), "a forced stop was relaunched");
    assert_eq!(main_pid(), None);
    ok(&butler(&["start", "--json"])?)?;
    let again = supervised(&launch);

    // A restart requested from inside the unit (its shell, or the service
    // itself) is one request to systemd: nothing in the unit has to outlive it.
    let inside = restart_from_inside_the_unit(&launch, &launcher);
    if inside {
        let deadline = Instant::now() + Duration::from_secs(90);
        while record(&launch).is_none_or(|record| record["nonce"] == again["nonce"]) {
            assert!(Instant::now() < deadline, "no restart from inside the unit");
            std::thread::sleep(Duration::from_millis(200));
        }
        supervised(&launch);
    } else {
        eprintln!("SKIPPED the in-unit restart: the unit's cgroup is not writable here");
    }

    // And an update onto the new version.
    let updated = ok(&butler(&["update", "--apply", "--yes", "--json"])?)?;
    assert_eq!(
        updated["data"]["service"]["onNewVersion"], true,
        "{updated}"
    );
    let last = supervised(&launch);
    assert!(
        last["executable"]
            .as_str()
            .unwrap()
            .contains(&format!("/{}/", v2.dir)),
        "{last}"
    );
    Ok(())
}
