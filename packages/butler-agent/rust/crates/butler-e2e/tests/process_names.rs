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
async fn process_roles_preserve_worker_protocol_and_executable_identity() -> Result<(), HarnessError>
{
    let sandbox = Sandbox::new("PROC-01")?;
    let launch = Launch::new(&sandbox)?;
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
            .arg(script)
            .arg(&sandbox.binary)
            .output()?;
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        process_names::prepare(&sandbox.binary)?;
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
