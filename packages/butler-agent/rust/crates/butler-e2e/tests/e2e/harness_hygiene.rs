//! The harness cleans successful runs and bounds postmortems.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use butler_e2e::e2e::{
    HarnessError,
    sandbox::{FAILURE_LIMIT, Sandbox},
    scenario::Setup,
};

#[tokio::test]
async fn successful_sandbox_and_scenario_are_deleted() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut sandbox = Sandbox::new("HYGIENE-DIRECT")?;
    let root = sandbox.root.clone();
    sandbox.mark_success();
    drop(sandbox);
    assert!(!root.exists());
    let s = Setup::new("HYGIENE-SUCCESS")?.start().await?;
    let root = s.sandbox.root.clone();
    s.finish().await?;
    assert!(
        !root.exists(),
        "successful scenario leaked {}",
        root.display()
    );
    Ok(())
}

#[tokio::test]
async fn unfinished_setup_keeps_only_the_last_five_failures() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    // Nested TMPDIR is supplied by the script runner so other tests' postmortems
    // are untouched; this test runs in its own nextest process.
    let mut isolated = Sandbox::new("HYGIENE-RETENTION")?;
    let output = std::process::Command::new(std::env::current_exe()?)
        .args(["retention_child", "--exact", "--nocapture"])
        .env("TMPDIR", isolated.root.join("tmp"))
        .env("BUTLER_E2E_RETENTION_CHILD", "1")
        .output()?;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let failures = isolated.root.join("tmp/butler-e2e/failures");
    let entries = std::fs::read_dir(failures)?.collect::<Result<Vec<_>, _>>()?;
    assert_eq!(entries.len(), FAILURE_LIMIT);
    assert!(
        entries
            .iter()
            .all(|entry| entry.path().join("data").is_dir())
    );
    for index in 2..FAILURE_LIMIT + 2 {
        assert!(entries.iter().any(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .contains(&format!("hygiene-fail-{index}-"))
        }));
    }
    assert!(String::from_utf8_lossy(&output.stderr).contains("E2E failure: kept"));
    isolated.mark_success();
    Ok(())
}

#[test]
fn retention_child() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    if std::env::var("BUTLER_E2E_RETENTION_CHILD").as_deref() != Ok("1") {
        return Ok(());
    }
    std::fs::create_dir_all(std::env::temp_dir())?;
    for index in 0..FAILURE_LIMIT + 2 {
        let failed = (|| -> Result<(), HarnessError> {
            let _setup = Setup::new(&format!("HYGIENE-FAIL-{index}"))?;
            Err(HarnessError("deliberate Result failure".into()))
        })();
        assert!(failed.is_err());
    }
    Ok(())
}

#[test]
fn isolated_runner_removes_home_and_data_on_both_exit_codes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut sandbox = Sandbox::new("HYGIENE-RUNNER")?;
    let script = sandbox.root.join("isolated-run.sh");
    std::fs::write(&script, include_str!("../../scripts/isolated-run.sh"))?;
    for code in [0, 7] {
        let output = std::process::Command::new("bash")
            .arg(&script)
            .args([
                "bash",
                "-c",
                "printf '%s\\n%s\\n' \"$HOME\" \"$BUTLER_DATA\"; exit \"$1\"",
                "runner",
                &code.to_string(),
            ])
            .env("TMPDIR", &sandbox.root)
            .output()?;
        assert_eq!(output.status.code(), Some(code));
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert_eq!(stdout.lines().count(), 2);
        for path in stdout.lines() {
            assert!(!std::path::Path::new(path).exists(), "runner leaked {path}");
        }
    }
    sandbox.mark_success();
    Ok(())
}

#[test]
fn mcp_fixture_uses_the_runtime_archive_path() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let path = butler_e2e::e2e::binary::mcp_fixture_binary()?;
    assert!(path.is_file(), "{}", path.display());
    if let Some(extract) = std::env::var_os("BUTLER_E2E_ARCHIVE_ROOT") {
        assert!(
            path.canonicalize()?
                .starts_with(std::path::Path::new(&extract).canonicalize()?),
            "fixture escaped extracted archive: {}",
            path.display()
        );
    }
    // Exercise the relocated executable, rather than merely checking existence.
    let output = std::process::Command::new(path)
        .stdin(std::process::Stdio::null())
        .output()?;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(())
}
