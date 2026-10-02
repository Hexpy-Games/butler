//! Platform contract tests: the operating-system behavior every other crate
//! relies on, pinned on each host (a capability a host lacks is asserted to
//! report so). Cross-process cases re-run this test binary as a helper
//! process (see [`helper`]).
#![allow(
    clippy::unwrap_used,
    clippy::zombie_processes,
    reason = "contract helpers abort the test on setup failure; helper processes are reaped by the test or outlive it by design"
)]

mod command_sandbox;
mod instance;
mod process_control;
mod secrets;
mod secure_fs;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Selects the helper role of a re-run test binary.
const ROLE: &str = "BUTLER_PLATFORM_CONTRACT_ROLE";
/// The file a helper reports to.
const REPORT: &str = "BUTLER_PLATFORM_CONTRACT_REPORT";
/// The lock file the `lock` helper holds.
const LOCK: &str = "BUTLER_PLATFORM_CONTRACT_LOCK";

/// The helper process entry point; an ordinary test run does nothing here.
///
/// Roles: `sleep` idles, `exit` exits at once, `tree` starts a `sleep`
/// grandchild (in its own process group) and reports its pid, `lock` takes
/// the exclusive lock of [`LOCK`] and reports `locked`.
#[test]
fn helper() {
    let Ok(role) = std::env::var(ROLE) else {
        return;
    };
    match role.as_str() {
        "exit" => {}
        "sleep" => std::thread::sleep(Duration::from_secs(60)),
        "tree" => {
            let grandchild = helper_command("sleep").spawn().unwrap();
            report(&grandchild.id().to_string());
            std::thread::sleep(Duration::from_secs(60));
        }
        "lock" => {
            let path = PathBuf::from(std::env::var_os(LOCK).unwrap());
            let _lock = butler_platform::instance::InstanceLock::try_exclusive(
                instance::open_lock_file(&path),
            )
            .unwrap();
            report("locked");
            std::thread::sleep(Duration::from_secs(60));
        }
        other => panic!("unknown helper role {other}"),
    }
    std::process::exit(0);
}

/// This test binary, run as the helper `role`.
fn helper_command(role: &str) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args(["helper", "--exact", "--nocapture", "--test-threads=1"])
        .env(ROLE, role);
    command
}

/// Writes the helper's report atomically, so a reader never sees half of it.
fn report(text: &str) {
    let path = PathBuf::from(std::env::var_os(REPORT).unwrap());
    let partial = path.with_extension("partial");
    fs::write(&partial, text).unwrap();
    fs::rename(partial, path).unwrap();
}

/// Waits for and reads a helper's report.
fn read_report(path: &Path) -> String {
    eventually("the helper's report", || path.exists());
    fs::read_to_string(path).unwrap()
}

/// A fresh scratch directory.
fn scratch(name: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "butler-platform-{name}-{}-{nanos}",
        std::process::id()
    ));
    fs::create_dir_all(&path).unwrap();
    path
}

/// Polls `condition` for up to 10 seconds.
fn eventually(what: &str, mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !condition() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

// test-category: security
#[test]
fn capabilities_match_the_host() {
    use butler_platform::secure_fs::{
        DIRECTORY_SYNC, FILE_IDS, NO_FOLLOW, OWNER_ONLY, PERMISSION_MODES,
    };
    let unix = cfg!(unix);
    assert_eq!(OWNER_ONLY, unix);
    assert_eq!(PERMISSION_MODES, unix);
    assert_eq!(NO_FOLLOW, unix);
    assert_eq!(FILE_IDS, unix);
    assert_eq!(DIRECTORY_SYNC, unix);

    let addresses = butler_platform::network::external_addresses();
    assert_eq!(
        addresses.is_some(),
        butler_platform::network::INTERFACE_ADDRESSES
    );
    let addresses = addresses.unwrap();
    assert!(!addresses.is_empty(), "host has no non-loopback address");
    assert!(addresses.iter().all(|ip| !ip.is_loopback()));
    assert!(addresses.windows(2).all(|pair| pair[0] < pair[1]));
}
