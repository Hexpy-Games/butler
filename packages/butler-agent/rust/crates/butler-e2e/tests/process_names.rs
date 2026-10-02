//! Role aliases execute the real worker without changing its identity or protocol.
#![allow(clippy::expect_used, reason = "E2E assertions")]
use std::process::Stdio;

use butler_e2e::e2e::{HarnessError, agent::Launch, sandbox::Sandbox};
use butler_platform::{
    process_names::{self, Role},
    secure_fs::Canonical,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

#[tokio::test]
async fn archived_process_roles_restore_only_identical_files() -> Result<(), HarnessError> {
    let sandbox = Sandbox::new("PROC-ZIP")?;
    process_names::prepare(&sandbox.binary)?;
    let aliases = [Role::Memory, Role::Restart, Role::Update]
        .map(|role| sandbox.binary.with_file_name(role.file_name()));
    for alias in &aliases {
        std::fs::remove_file(alias)?;
        std::fs::copy(&sandbox.binary, alias)?;
    }
    assert!(process_names::prepare(&sandbox.binary).is_err());
    let directory = sandbox.binary.parent().expect("binary parent");
    let permissions = std::fs::metadata(directory)?.permissions();
    let mut read_only = permissions.clone();
    read_only.set_readonly(true);
    std::fs::set_permissions(directory, read_only.clone())?;
    let restored = process_names::restore_archive_links(&sandbox.binary);
    let after = std::fs::metadata(directory)?.permissions();
    std::fs::set_permissions(directory, permissions)?;
    restored?;
    assert_eq!(after, read_only);
    process_names::prepare(&sandbox.binary)?;
    for role in [Role::Memory, Role::Restart, Role::Update] {
        let alias = process_names::executable(&sandbox.binary, role)?;
        assert_eq!(
            process_names::canonical_executable(&alias)?,
            sandbox.binary.canonical()?
        );
    }
    std::fs::remove_file(&aliases[0])?;
    std::fs::write(&aliases[0], b"foreign")?;
    assert!(process_names::restore_archive_links(&sandbox.binary).is_err());
    assert_eq!(std::fs::read(&aliases[0])?, b"foreign");
    // Same-sized foreign code must also be refused before any links change.
    std::fs::copy(&sandbox.binary, &aliases[0])?;
    use std::io::Write;
    std::fs::OpenOptions::new()
        .write(true)
        .open(&aliases[0])?
        .write_all(b"foreign")?;
    assert!(process_names::restore_archive_links(&sandbox.binary).is_err());
    assert_eq!(
        std::fs::metadata(&aliases[0])?.len(),
        std::fs::metadata(&sandbox.binary)?.len()
    );
    Ok(())
}

#[tokio::test]
async fn process_roles_preserve_worker_protocol_and_executable_identity() -> Result<(), HarnessError>
{
    // Like every Agent E2E, run only after the explicit tier has prepared its binary.
    butler_e2e::gate!();
    let sandbox = Sandbox::new("PROC-01")?;
    let launch = Launch::new(&sandbox)?;
    for (role, full_name, linux_comm) in [
        (Role::Memory, "butler-agent (memory)", "butler-memory"),
        (Role::Restart, "butler-agent (restart)", "butler-restart"),
        (Role::Update, "butler-agent (update)", "butler-update"),
    ] {
        assert_eq!(role.name(), full_name);
        assert_eq!(role.short_name(), linux_comm);
    }
    let output = launch
        .env_command(&sandbox.binary)
        .arg("--prepare-process-links")
        .output()?;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    for role in [Role::Memory, Role::Restart, Role::Update] {
        let alias = process_names::executable(&sandbox.binary, role)?;
        assert_eq!(
            alias.file_name().and_then(|name| name.to_str()),
            Some(role.file_name())
        );
        assert_eq!(
            process_names::canonical_executable(&alias)?,
            sandbox.binary.canonical()?
        );
    }
    for role in [Role::Memory, Role::Restart, Role::Update] {
        verify_worker(&sandbox, &launch, role).await?;
    }
    // Electron packagers can copy aliases into distinct files. The actual
    // packaging hook must rebuild links before sealing the installation.
    if process_names::executable(&sandbox.binary, Role::Memory)? != sandbox.binary {
        for role in [Role::Memory, Role::Restart, Role::Update] {
            let alias = process_names::executable(&sandbox.binary, role)?;
            std::fs::remove_file(&alias)?;
            std::fs::copy(&sandbox.binary, &alias)?;
        }
        assert!(process_names::prepare(&sandbox.binary).is_err());
        let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(
            "../../../../../packages/butler-app/client/electron/scripts/prepare-process-links.mjs",
        );
        let output = launch
            .env_command(std::path::Path::new("node"))
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .arg(&script)
            .arg(&sandbox.binary)
            .output()?;
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        process_names::prepare(&sandbox.binary)?;
        verify_legacy_layout(&sandbox, &launch, &script)?;
    }
    // A pre-existing foreign filename is never executed or overwritten.
    let alias = process_names::executable(&sandbox.binary, Role::Memory)?;
    if alias != sandbox.binary {
        std::fs::remove_file(&alias)?;
        std::fs::write(&alias, b"foreign")?;
        assert!(process_names::prepare(&sandbox.binary).is_err());
        assert!(process_names::executable(&sandbox.binary, Role::Memory).is_err());
        assert_eq!(std::fs::read(&alias)?, b"foreign");
    }
    Ok(())
}

async fn verify_worker(sandbox: &Sandbox, launch: &Launch, role: Role) -> Result<(), HarnessError> {
    let alias = process_names::executable(&sandbox.binary, role)?;
    let mut command = tokio::process::Command::from(launch.env_command(&alias));
    process_names::name_command(command.as_std_mut(), role);
    let mut child = command
        .arg("--private-embedding-worker")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let pid = child.id().expect("running worker");
    let mut stdin = child.stdin.take().expect("worker stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("worker stdout"));
    // Wait for a real protocol response, without loading a model or network.
    stdin.write_all(b"invalid-json\n").await?;
    let mut line = String::new();
    stdout.read_line(&mut line).await?;
    let response: serde_json::Value = serde_json::from_str(&line)?;
    assert_eq!(response["status"], "error");
    if let Some((observed, expected)) = process_names::observed_name(pid, role)? {
        assert_eq!(observed, expected);
        let args = std::process::Command::new("ps")
            .args(["-ww", "-p"])
            .arg(pid.to_string())
            .args(["-o", "args="])
            .output()?;
        assert!(args.status.success(), "ps failed for worker {pid}");
        let args = String::from_utf8_lossy(&args.stdout);
        assert!(
            args.trim_start().starts_with(role.name()),
            "worker argv[0] did not show {}: {args}",
            role.name()
        );
    }
    let observed =
        butler_platform::instance::process_executable(pid).map_err(std::io::Error::other)?;
    assert_eq!(observed.as_deref(), sandbox.binary.canonical()?.to_str());
    stdin.write_all(b"{\"id\":1,\"op\":\"close\"}\n").await?;
    line.clear();
    stdout.read_line(&mut line).await?;
    let response: serde_json::Value = serde_json::from_str(&line)?;
    assert_eq!(response["id"], 1);
    assert_eq!(response["status"], "closed");
    drop(stdin);
    assert!(child.wait().await?.success(), "worker {pid} failed");
    Ok(())
}

fn verify_legacy_layout(
    sandbox: &Sandbox,
    launch: &Launch,
    script: &std::path::Path,
) -> Result<(), HarnessError> {
    let root = sandbox.root.join("legacy");
    std::fs::create_dir(&root)?;
    let binary = root.join("butler-agent");
    match process_names::write_legacy_fixture(&binary) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::Unsupported => return Ok(()),
        Err(error) => return Err(error.into()),
    }
    process_names::prepare_installation(&binary)?;
    let output = launch
        .env_command(std::path::Path::new("node"))
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .arg(script)
        .arg(&binary)
        .output()?;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        std::fs::read_dir(root)?.count(),
        1,
        "legacy binary gained aliases"
    );
    Ok(())
}
