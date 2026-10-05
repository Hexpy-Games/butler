//! Native ZIP rejection and killed-helper recovery; only locally signed temp Apps.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use super::install_support;
use butler_e2e::e2e::{HarnessError, agent::Launch, sandbox::Sandbox};
use std::{
    fs,
    path::Path,
    process::{Command, Stdio},
    time::Duration,
};

fn helper(launch: &Launch, artifact: &Path, bundle: &Path, checkpoint: &str) -> Command {
    let mut command = launch.command();
    command
        .arg("app-update-install")
        .arg(artifact)
        .arg(bundle.join("Contents/MacOS/Butler"))
        .arg("2147483647")
        .env("BUTLER_APP_UPDATE_CHECKPOINT", checkpoint)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

#[test]
fn hostile_zips_cannot_change_the_installed_bundle_or_escape_staging() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    if butler_platform::app_update::package_format() != "zip" {
        return Ok(());
    }
    let (sandbox, launch) = install_support::sandbox("mac-hostile-zip")?;
    let bundle = sandbox.root.join("Butler.app");
    butler_platform::app_update::test_support::signed_bundle(&bundle, "1")?;
    for (case, reason) in [
        ("traversal", "Unsafe ZIP path"),
        ("absolute", "Unsafe ZIP path"),
        ("symlink", "ZIP link escapes"),
        ("hardlink", "ZIP hard link metadata refused"),
        ("oversized", "ZIP is too large"),
        ("fifo", "Special ZIP entry refused"),
        ("link-write", "ZIP writes through a link"),
        ("case-link", "ZIP link destination is unavailable"),
    ] {
        let archive = sandbox.root.join(format!("{case}.zip"));
        butler_platform::app_update::test_support::hostile_zip(&archive, case)?;
        let output = helper(&launch, &archive, &bundle, "").output()?;
        assert!(!output.status.success(), "accepted {case}");
        let diagnostic = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(diagnostic.contains(reason), "{case}: {diagnostic}");
        assert!(!String::from_utf8_lossy(&output.stdout).contains("app-update-ready"));
        assert_eq!(
            Command::new(bundle.join("Contents/MacOS/Butler"))
                .output()?
                .stdout,
            b"1\n"
        );
        assert!(!sandbox.root.join("escaped").exists());
        assert!(!bundle.with_extension("app.update.json").exists());
    }
    Ok(())
}

#[tokio::test]
async fn killed_update_helpers_leave_a_runnable_bundle_and_startup_recovers()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    if butler_platform::app_update::package_format() != "zip" {
        return Ok(());
    }
    for checkpoint in ["journal", "exchange", "synced", "launched", "cleanup"] {
        let (sandbox, launch) = install_support::sandbox(&format!("mac-swap-{checkpoint}"))?;
        let bundle = sandbox.root.join("installed/Butler.app");
        let candidate = sandbox.root.join("source/Butler.app");
        let archive = sandbox.root.join("candidate.zip");
        prepare_fixture(&sandbox, &bundle, &candidate, &archive)?;
        kill_at(&launch, &archive, &bundle, checkpoint).await?;
        let expected = if checkpoint == "journal" {
            b"1\n"
        } else {
            b"2\n"
        };
        assert_eq!(
            Command::new(bundle.join("Contents/MacOS/Butler"))
                .output()?
                .stdout,
            expected
        );
        startup_recovery(&sandbox, &bundle, expected)?;
    }
    Ok(())
}

fn prepare_fixture(
    sandbox: &Sandbox,
    bundle: &Path,
    candidate: &Path,
    archive: &Path,
) -> Result<(), HarnessError> {
    butler_platform::app_update::test_support::signed_bundle(bundle, "1")?;
    butler_platform::app_update::test_support::signed_bundle(candidate, "2")?;
    butler_platform::app_update::test_support::bundle_zip(candidate, archive)?;
    let diagnostic = sandbox.root.join("extraction-proof");
    butler_platform::app_update::test_support::extract_fixture(archive, &diagnostic).unwrap();
    let proof = Command::new("codesign")
        .args(["--verify", "--deep", "--strict", "--verbose=4"])
        .arg(diagnostic.join("Butler.app"))
        .output()?;
    assert!(
        proof.status.success(),
        "{}; changed files: {:?}",
        String::from_utf8_lossy(&proof.stderr),
        butler_platform::app_update::test_support::fixture_differences(
            candidate,
            &diagnostic.join("Butler.app")
        )?
    );
    Ok(())
}

async fn kill_at(
    launch: &Launch,
    archive: &Path,
    bundle: &Path,
    checkpoint: &str,
) -> Result<(), HarnessError> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let mut child = tokio::process::Command::from(helper(launch, archive, bundle, checkpoint))
        .kill_on_drop(true)
        .spawn()?;
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let ready = tokio::time::timeout(Duration::from_secs(20), lines.next_line())
        .await
        .unwrap()?;
    if ready.is_none() {
        use tokio::io::AsyncReadExt;
        let mut diagnostic = String::new();
        child
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut diagnostic)
            .await?;
        panic!("App preparation failed: {diagnostic}");
    }
    assert_eq!(ready.as_deref(), Some("app-update-ready"));
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(b"activate\n")
        .await?;
    let step = format!("app-update-checkpoint:{checkpoint}");
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let line = lines.next_line().await.unwrap().expect("helper checkpoint");
            if line == step {
                break;
            }
        }
    })
    .await
    .unwrap();
    child.kill().await?;
    child.wait().await?;
    Ok(())
}

fn startup_recovery(sandbox: &Sandbox, bundle: &Path, expected: &[u8]) -> Result<(), HarnessError> {
    // Put the real native executable inside the installed bundle: its
    // normal startup path must finish recovery, without a special test API.
    let native = bundle.join("Contents/Resources/recovery-agent");
    fs::copy(&sandbox.binary, &native)?;
    let result = Command::new(native)
        // The native entrypoint recovers before dispatching its private
        // worker; owner EOF then exits without resolving an installation.
        .arg("--private-embedding-worker")
        .stdin(Stdio::null())
        .env("HOME", &sandbox.home)
        .env("BUTLER_DATA", &sandbox.data)
        .output()?;
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(!bundle.with_extension("app.update.json").exists());
    assert!(!fs::read_dir(bundle.parent().unwrap())?.any(|e| {
        e.unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".butler-update.")
    }));
    assert_eq!(
        Command::new(bundle.join("Contents/MacOS/Butler"))
            .output()?
            .stdout,
        expected
    );
    Ok(())
}

#[test]
fn signed_but_unrunnable_candidate_is_rejected_before_exchange() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    if butler_platform::app_update::package_format() != "zip" {
        return Ok(());
    }
    let (sandbox, launch) = install_support::sandbox("mac-non-executable")?;
    let bundle = sandbox.root.join("installed/Butler.app");
    let candidate = sandbox.root.join("source/Butler.app");
    let archive = sandbox.root.join("candidate.zip");
    prepare_fixture(&sandbox, &bundle, &candidate, &archive)?;
    butler_platform::app_update::test_support::remove_launch_permission(&candidate)?;
    butler_platform::app_update::test_support::bundle_zip(&candidate, &archive)?;
    let output = helper(&launch, &archive, &bundle, "").output()?;
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("Updated App is not executable"));
    assert!(!String::from_utf8_lossy(&output.stdout).contains("app-update-ready"));
    assert!(!bundle.with_extension("app.update.json").exists());
    assert_eq!(
        Command::new(bundle.join("Contents/MacOS/Butler"))
            .output()?
            .stdout,
        b"1\n"
    );
    Ok(())
}
