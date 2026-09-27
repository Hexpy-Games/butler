//! INS-01 — the user's `butler` command after the native cutover.
//!
//! Releases before the native Agent installed a Bun-compiled launcher at
//! `D/bin/butler` that runs `$BUTLER_HOME/bin/butler.js`; that script is gone,
//! so the launcher fails with "Module not found". Starting the service must
//! replace it with one that runs the installed native Agent.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Command, Output, Stdio};

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::scenario::Setup;

/// Stand-in for the stale Bun launcher: it fails the way the real one does.
const STALE_LAUNCHER: &str = "#!/bin/sh\n\
echo 'error: Module not found \"/Users/owner/butler/bin/butler.js\"' >&2\n\
exit 1\n";

/// Runs `launcher` like a user's shell would: only `HOME` and `PATH`, no
/// `BUTLER_DATA`, so the launcher itself must select its data dir.
fn run_launcher(launcher: &Path, home: &Path, args: &[&str]) -> Result<Output, HarnessError> {
    Ok(Command::new(launcher)
        .args(args)
        .env_clear()
        .env("HOME", home)
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("LANG", "en_US.UTF-8")
        .stdin(Stdio::null())
        .output()?)
}

/// INS-01 — a stale pre-native launcher at `D/bin/butler` is replaced when
/// the service starts; `butler auth status` then runs the native Agent on
/// this data dir, and the old launcher is kept aside.
#[tokio::test]
async fn ins_01_stale_launcher_is_replaced_at_start() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("INS-01")?;
    let bin = setup.sandbox.data.join("bin");
    fs::create_dir_all(&bin)?;
    let launcher = bin.join("butler");
    fs::write(&launcher, STALE_LAUNCHER)?;
    fs::set_permissions(&launcher, fs::Permissions::from_mode(0o755))?;
    let home = setup.sandbox.home.clone();
    let stale = run_launcher(&launcher, &home, &["auth", "status", "--json"])?;
    assert!(!stale.status.success(), "stale launcher stand-in succeeded");

    let s = setup.start().await?;
    let output = run_launcher(&launcher, &home, &["auth", "status", "--json"])?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "butler auth status failed after start: {stdout}\n{stderr}"
    );
    let status: serde_json::Value = serde_json::from_str(stdout.trim())
        .unwrap_or_else(|error| panic!("auth status is not JSON ({error}): {stdout}\n{stderr}"));
    assert_eq!(status["ok"], true, "{status}");
    assert_eq!(status["command"], "butler auth status", "{status}");
    assert_eq!(
        fs::read_to_string(bin.join("butler.previous"))?,
        STALE_LAUNCHER,
        "the replaced launcher was not kept aside"
    );

    // A restart leaves the now-current launcher as it is.
    let current = fs::read(&launcher)?;
    let mut s = s;
    s.restart().await?;
    assert_eq!(fs::read(&launcher)?, current, "restart rewrote the launcher");
    s.finish().await
}
