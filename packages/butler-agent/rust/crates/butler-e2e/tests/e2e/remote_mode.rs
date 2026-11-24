//! A detached SSH service serves its owner-only socket and exits when idle.
use butler_e2e::e2e::{
    HarnessError,
    agent::Launch,
    harness_error, listening_tcp_ports,
    sandbox::Sandbox,
    sshd::TestSshd,
    stop_intent::{StopOnDrop, instance_record},
};
use butler_platform::{instance::process_start, local_socket};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, Instant},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Stop the recorded service before removing its short data directory on every path.
pub(super) struct RemoteData(pub(super) Launch);

impl Drop for RemoteData {
    fn drop(&mut self) {
        drop(StopOnDrop(self.0.clone()));
        let _ = fs::remove_dir_all(&self.0.data);
    }
}

pub(super) fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

async fn request_status(
    socket: &Path,
    target: &str,
    token: &str,
    admin: Option<&str>,
) -> Result<u16, HarnessError> {
    let mut stream = local_socket::connect(socket).await?;
    let admin = admin
        .map(|secret| format!("X-Butler-Admin: {secret}\r\n"))
        .unwrap_or_default();
    let request = format!(
        "GET {target} HTTP/1.1\r\nHost: agent\r\nAuthorization: Bearer {token}\r\n{admin}Connection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).await?;
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await?;
    String::from_utf8_lossy(&response)
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| harness_error("socket response has no status"))?
        .parse()
        .map_err(|error| harness_error(format!("invalid HTTP status: {error}")))
}

#[tokio::test]
async fn remote_mode_serves_only_through_its_socket_and_exits_when_idle() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    let mut sandbox = Sandbox::new("REMOTE-MODE")?;
    let key = sandbox.home.join("user_key");
    let generated = Command::new("ssh-keygen")
        .args(["-q", "-t", "ed25519", "-N", "", "-f"])
        .arg(&key)
        .output()?;
    assert!(generated.status.success());
    let sshd = TestSshd::start(&sandbox.home.join("sshd"), &key.with_extension("pub"), None)?;
    let mut launch = Launch::new(&sandbox)?;
    launch.data = PathBuf::from(format!(
        "/tmp/bre-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    fs::create_dir(&launch.data)?;
    let data = RemoteData(launch);
    let mut command = data.0.command_without_local_auth();
    command
        .args(["start", "--remote", "--data"])
        .arg(&data.0.data)
        .arg("--json")
        .env("HOME", &sandbox.home)
        .env("BUTLER_DATA", &data.0.data)
        .env("BUTLER_REMOTE_IDLE_SECONDS", "30");
    let mut words = vec!["env -i".to_owned()];
    words.extend(command.get_envs().filter_map(|(key, value)| {
        value.map(|value| {
            shell_quote(&format!(
                "{}={}",
                key.to_string_lossy(),
                value.to_string_lossy()
            ))
        })
    }));
    words.push(shell_quote(&command.get_program().to_string_lossy()));
    words.extend(
        command
            .get_args()
            .map(|arg| shell_quote(&arg.to_string_lossy())),
    );
    let output = Command::new("ssh")
        .args([
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=no",
            "-o",
            "UserKnownHostsFile=/dev/null",
            "-i",
        ])
        .arg(&key)
        .args(["-o", "IdentitiesOnly=yes", "-p"])
        .arg(sshd.port.to_string())
        .arg("127.0.0.1")
        .arg(words.join(" "))
        .output()?;
    assert!(
        output.status.success(),
        "SSH start failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let started: Value = serde_json::from_slice(&output.stdout)?;
    assert_eq!(started["ok"], true);
    let record = instance_record(&data.0.data).ok_or_else(|| harness_error("no service record"))?;
    let pid = record["pid"]
        .as_u64()
        .and_then(|pid| u32::try_from(pid).ok())
        .ok_or_else(|| harness_error("no service PID"))?;
    assert_eq!(started["data"]["pid"], pid);
    let socket = data.0.data.join("remote/agent.sock");
    assert!(local_socket::owner_only(&socket)?);
    assert!(local_socket::owner_only(&data.0.data.join("remote"))?);
    let token = data
        .0
        .data_folder_token()
        .ok_or_else(|| harness_error("no local token"))?;
    let admin = data
        .0
        .admin_credential()
        .ok_or_else(|| harness_error("no admin credential"))?;
    assert_eq!(request_status(&socket, "/health", &token, None).await?, 200);
    assert_eq!(
        request_status(&socket, "http://agent/computers", &token, Some(&admin)).await?,
        200
    );
    let control = record["control_endpoint"]
        .as_str()
        .and_then(|endpoint| endpoint.parse::<std::net::SocketAddr>().ok())
        .ok_or_else(|| harness_error("no control endpoint"))?;
    assert_eq!(listening_tcp_ports(pid).await?, [control.port()].into());
    let idle_started = Instant::now();
    while process_start(pid)
        .map_err(|error| harness_error(error.to_string()))?
        .is_some()
    {
        if idle_started.elapsed() >= Duration::from_secs(60) {
            return Err(harness_error("remote service did not exit when idle"));
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert!(!socket.exists(), "remote socket survived service exit");
    eprintln!("remote service idle exit: {:?}", idle_started.elapsed());
    drop(data);
    drop(sshd);
    sandbox.mark_success();
    Ok(())
}
