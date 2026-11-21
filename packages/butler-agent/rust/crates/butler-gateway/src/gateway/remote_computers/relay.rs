//! Relay a request to the computer's local socket over its pinned SSH connection.
use super::{Computer, HostInput, HttpError, deploy, remote_error, ssh, store::KnownHosts};
use butler_platform::secrets::SecretText;
use serde::Deserialize;
use serde_json::{Value, json};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

#[derive(Deserialize)]
pub(super) struct Reply {
    pub status: u16,
    pub body: Value,
}

pub(super) async fn request(
    computer: &Computer,
    method: &str,
    path: &str,
    body: Vec<u8>,
    cancel: CancellationToken,
) -> Result<Reply, HttpError> {
    let known_hosts = KnownHosts::write(computer.host_keys.iter().cloned().collect()).await?;
    let target = HostInput {
        address: computer.address.clone(),
        port: computer.port.map(i64::from),
        key_file: computer.key_file.clone(),
    };
    let home = butler_platform::user_dirs::non_empty_home_dir();
    let quote = |value: &str| format!("'{}'", value.replace('\'', "'\\''"));
    let command = format!(
        r#""$HOME/.butler-remote/current/butler-agent" --remote-request "$HOME/.butler-remote/data" {} {}"#,
        quote(method),
        quote(path)
    );
    let args = ssh::arguments(
        &target,
        &known_hosts.0,
        "yes",
        &[],
        &command,
        home.as_deref(),
    )?;
    let output = ssh::run(
        args,
        ssh::Stdin::Bytes(body),
        Duration::from_mins(3),
        cancel,
    )
    .await?;
    if output.exit_code == Some(255) {
        deploy::check_exit(&output)?;
    }
    let unavailable = || {
        remote_error(
            "remote_unavailable",
            "This computer's Butler is not running.",
        )
    };
    if output.exit_code != Some(0) {
        return Err(unavailable());
    }
    serde_json::from_str(&output.stdout).map_err(|_| unavailable())
}

pub(super) async fn unlock(
    computer: &Computer,
    identity: &SecretText,
    cancel: CancellationToken,
) -> Result<(), HttpError> {
    let body = json!({"identity": identity.expose()})
        .to_string()
        .into_bytes();
    match request(computer, "POST", "/remote/unlock", body, cancel)
        .await?
        .status
    {
        204 => Ok(()),
        403 => Err(HttpError::public(
            409,
            "remote_key_mismatch",
            "This computer's account is locked to another key.",
        )),
        _ => Err(remote_error(
            "remote_unlock_failed",
            "Could not unlock this computer's account.",
        )),
    }
}

pub(super) fn data(reply: Reply) -> Result<Value, HttpError> {
    if (200..300).contains(&reply.status) {
        let mut body = reply.body;
        return Ok(body.get_mut("data").map_or(Value::Null, Value::take));
    }
    let code = "remote_request_failed";
    let message = "The computer refused the request.";
    if reply.status == 401 {
        return Err(remote_error(code, message));
    }
    Err(HttpError::public(
        reply.status,
        reply.body["error"]["code"].as_str().unwrap_or(code),
        reply.body["error"]["message"].as_str().unwrap_or(message),
    ))
}
