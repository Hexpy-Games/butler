//! The remote stores model credentials under the key supplied by the main.
use super::remote_mode::{RemoteData, shell_quote};
use age::{secrecy::ExposeSecret, x25519::Identity};
use butler_e2e::e2e::{
    HarnessError, agent::Launch, harness_error, sandbox::Sandbox, sshd::TestSshd,
    stop_intent::instance_record,
};
use butler_platform::{local_socket, process_hardening};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::test]
async fn remote_credentials_stay_sealed_and_need_the_main_key() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    let mut sandbox = Sandbox::new("REMOTE-ACCOUNT")?;
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
    let command = data.0.command_without_local_auth();
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

    let identity = Identity::generate();
    let unlock = json!({"identity": identity.to_string().expose_secret()});
    let wrong = json!({"identity": Identity::generate().to_string().expose_secret()});
    let k1 = uuid::Uuid::new_v4().to_string();
    let k2 = uuid::Uuid::new_v4().to_string();
    let first = json!({"provider_id":"openai", "api_key":k1});
    let second = json!({"provider_id":"openai", "api_key":k2});
    let path = data.0.data.join("auth/remote-credentials.age");
    for (index, action) in ["start --remote", "stop", "start --remote"]
        .into_iter()
        .enumerate()
    {
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
            .arg(format!(
                "{} {action} --data {} --json",
                words.join(" "),
                shell_quote(&data.0.data.to_string_lossy())
            ))
            .output()?;
        assert!(
            output.status.success(),
            "SSH command failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let started: Value = serde_json::from_slice(&output.stdout)?;
        assert_eq!(started["ok"], true);

        if action == "stop" {
            continue;
        }
        let token = data
            .0
            .data_folder_token()
            .ok_or_else(|| harness_error("no local token"))?;
        let admin = data
            .0
            .admin_credential()
            .ok_or_else(|| harness_error("no admin credential"))?;
        let requests = if index == 0 {
            vec![
                ("/credentials", &first, 409, "remote_key_pending"),
                ("/remote/unlock", &unlock, 204, ""),
                ("/credentials", &first, 201, ""),
            ]
        } else {
            vec![
                ("/credentials", &second, 409, "remote_key_pending"),
                ("/remote/unlock", &wrong, 403, "remote_key_mismatch"),
                ("/remote/unlock", &unlock, 204, ""),
                ("/credentials", &second, 201, ""),
            ]
        };
        for (route, body, status, code) in requests {
            let mut stream = local_socket::connect(&data.0.data.join("remote/agent.sock")).await?;
            let body = body.to_string();
            let request = format!(
                "POST http://agent{route} HTTP/1.1\r\nHost: agent\r\nAuthorization: Bearer {token}\r\nX-Butler-Admin: {admin}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(request.as_bytes()).await?;
            let mut response = String::new();
            stream.read_to_string(&mut response).await?;
            let (headers, payload) = response
                .split_once("\r\n\r\n")
                .ok_or_else(|| harness_error("invalid socket response"))?;
            assert_eq!(
                headers
                    .split_whitespace()
                    .nth(1)
                    .and_then(|value| value.parse::<u16>().ok()),
                Some(status)
            );
            if !code.is_empty() {
                assert_eq!(
                    serde_json::from_str::<Value>(payload)?["error"]["code"],
                    code
                );
            }
        }
        if index == 0 {
            assert!(
                !fs::read(&path)?
                    .windows(k1.len())
                    .any(|bytes| bytes == k1.as_bytes())
            );
        }
    }
    let plain = age::decrypt(&identity, &fs::read(path)?)
        .map_err(|error| harness_error(error.to_string()))?;
    let map: BTreeMap<String, String> = serde_json::from_slice(&plain)?;
    assert!(map.values().any(|value| value == &k1));
    assert!(map.values().any(|value| value == &k2));
    drop(data);
    drop(sshd);
    sandbox.mark_success();
    Ok(())
}

#[tokio::test]
async fn remote_agent_memory_is_not_readable_by_another_process() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        process_hardening::memory_readable(std::process::id()).is_ok(),
        "Linux only"
    );
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    let mut sandbox = Sandbox::new("REMOTE-ACCOUNT")?;
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
        .env("BUTLER_DATA", &data.0.data);
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
    assert!(matches!(process_hardening::memory_readable(pid), Ok(false)));
    drop(data);
    drop(sshd);
    sandbox.mark_success();
    Ok(())
}
