//! INS-07 — which versions stay and which one `rollback` returns to.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use super::install_support;

use std::fs;

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::agent::Launch;
use butler_e2e::e2e::install_fixture::{Archive, build_stub_archive, make_read_only};
use install_support::{error_code, ok, run, sandbox};

/// `(version, active, previous)` of every installed version, newest first.
type Listing = Vec<(String, bool, bool)>;

fn installed(launch: &Launch) -> Result<Listing, HarnessError> {
    let home = launch
        .env
        .iter()
        .find(|(key, _)| key == "BUTLER_AGENT_HOME")
        .unwrap()
        .1
        .clone();
    let home = std::path::Path::new(&home);
    let active = butler_platform::install_link::read(home, "current")?.unwrap_or_default();
    let previous = butler_platform::install_link::read(home, "previous")?.unwrap_or_default();
    let mut entries = Vec::new();
    for entry in fs::read_dir(home)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let manifest = entry.path().join("native-agent-manifest.json");
        if !manifest.is_file() {
            continue;
        }
        let value: serde_json::Value = serde_json::from_slice(&fs::read(manifest)?)?;
        let name = entry.file_name().to_string_lossy().into_owned();
        entries.push((
            value["version"].as_str().unwrap().to_owned(),
            active.trim() == name,
            previous.trim() == name,
        ));
    }
    entries.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(entries)
}

fn entry(version: &str, active: bool, previous: bool) -> (String, bool, bool) {
    (version.to_owned(), active, previous)
}

fn active_version(launch: &Launch) -> Result<String, HarnessError> {
    Ok(installed(launch)?
        .into_iter()
        .find(|version| version.1)
        .map(|version| version.0)
        .unwrap_or_default())
}

/// INS-07 — versions accumulate, are pruned to the newest three plus the
/// active and previous ones (unpacked read-only trees included), and
/// `rollback` names its target by pointer, by version or by directory.
#[test]
fn ins_07_prune_and_rollback_choose_the_right_versions() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut sandbox, launch) = sandbox("INS-07")?;
    let home = sandbox.root.join("agent-home");
    let fixtures = sandbox.root.join("fixtures");
    let install = |archive: &Archive| {
        run(launch.command().args([
            "install",
            "--from",
            &archive.path.display().to_string(),
            "--no-restart",
            "--json",
        ]))
    };
    let rollback = |args: &[&str]| {
        let mut command = launch.command();
        command
            .arg("rollback")
            .args(args)
            .arg("--no-restart")
            .arg("--json");
        run(&mut command)
    };
    assert_eq!(
        error_code(&rollback(&["--yes"])?)?,
        "install_nothing_to_roll_back"
    );

    let stubs = (1..=5)
        .map(|n| build_stub_archive(&fixtures, &format!("1.0.{n}"), "x"))
        .collect::<Result<Vec<_>, _>>()?;
    for (index, archive) in stubs.iter().enumerate() {
        ok(&install(archive)?)?;
        if index == 0 {
            make_read_only(&home.join(&archive.dir))?;
        }
    }
    assert_eq!(
        installed(&launch)?,
        [
            entry("1.0.5", true, false),
            entry("1.0.4", false, true),
            entry("1.0.3", false, false),
        ],
        "1.0.1 (read-only) and 1.0.2 should have been pruned"
    );
    assert!(!home.join(&stubs[0].dir).exists());

    // By version, then back: the version that was active becomes `previous`.
    let dry = ok(&rollback(&["--to", "1.0.3", "--dry-run"])?)?;
    assert_eq!(dry["data"]["dryRun"], true, "{dry}");
    assert_eq!(active_version(&launch)?, "1.0.5", "a dry run switched");
    assert_eq!(
        error_code(&rollback(&["--to", "1.0.3"])?)?,
        "confirmation_required"
    );
    ok(&rollback(&["--to", "1.0.3", "--yes"])?)?;
    assert_eq!(
        installed(&launch)?,
        [
            entry("1.0.5", false, true),
            entry("1.0.4", false, false),
            entry("1.0.3", true, false),
        ]
    );
    ok(&rollback(&["--yes"])?)?;
    assert_eq!(active_version(&launch)?, "1.0.5");
    assert_eq!(
        error_code(&rollback(&["--to", "9.9.9", "--yes"])?)?,
        "install_version_not_found"
    );

    // Without a usable `previous`, the newest other version is the target.
    fs::remove_file(home.join("previous"))?;
    ok(&rollback(&["--yes"])?)?;
    assert_eq!(active_version(&launch)?, "1.0.4");

    // Two directories with one version: the version is ambiguous, the
    // directory name is not.
    let twin = build_stub_archive(&fixtures, "1.0.5", "twin")?;
    ok(&install(&twin)?)?;
    let ambiguous = rollback(&["--to", "1.0.5", "--yes"])?;
    assert_eq!(error_code(&ambiguous)?, "install_version_ambiguous");
    ok(&rollback(&["--to", &stubs[4].dir, "--yes"])?)?;
    assert_eq!(active_version(&launch)?, "1.0.5");
    sandbox.mark_success();
    Ok(())
}
