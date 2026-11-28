//! Relay a request to the computer's local socket over its pinned SSH connection.
use super::{
    Computer, HttpError, deploy,
    remote_command::{self, Shell},
    remote_error, ssh,
    target::SshTarget,
};
use butler_platform::secrets::SecretText;
use serde::Deserialize;
use serde_json::{Value, json};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

#[derive(Deserialize)]
pub(in crate::gateway) struct Reply {
    pub status: u16,
    pub body: Value,
    #[serde(default)]
    pub bytes: Option<String>,
    #[serde(default)]
    pub headers: std::collections::BTreeMap<String, String>,
}

pub(super) async fn request(
    computer: &Computer,
    method: &str,
    path: &str,
    body: Vec<u8>,
    cancel: CancellationToken,
) -> Result<Reply, HttpError> {
    match send(computer, method, path, body, cancel).await? {
        Sent::Reply(reply) => Ok(reply),
        Sent::NotRunning => Err(unavailable()),
    }
}

pub(super) enum Sent {
    Reply(Reply),
    NotRunning,
}

pub(super) async fn send(
    computer: &Computer,
    method: &str,
    path: &str,
    body: Vec<u8>,
    cancel: CancellationToken,
) -> Result<Sent, HttpError> {
    let target = SshTarget::of(computer).await?;
    let command = remote_command::request(Shell::of(&computer.os), method, path);
    let args = target.arguments("yes", &[], &command)?;
    let output = ssh::run(
        args,
        ssh::Stdin::Bytes(body),
        Duration::from_mins(3),
        cancel,
    )
    .await?;
    if output.exit_code != Some(0) && output.stderr.contains("code=remote_response_invalid") {
        return Err(remote_error(
            "remote_response_invalid",
            "This computer's reply could not be read.",
        ));
    }
    if output.exit_code == Some(255) {
        deploy::check_exit(&output)?;
    }
    if output.exit_code == Some(127) || output.stderr.contains("code=remote_not_running") {
        return Ok(Sent::NotRunning);
    }
    if output.exit_code != Some(0) {
        return Err(unavailable());
    }
    serde_json::from_str(&output.stdout)
        .map(Sent::Reply)
        .map_err(|_| unavailable())
}

pub(super) fn unavailable() -> HttpError {
    remote_error(
        "remote_unavailable",
        "This computer's Butler is not running.",
    )
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

pub(in crate::gateway) fn data(reply: Reply) -> Result<Value, HttpError> {
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

pub(super) async fn loopback(
    computer: &Computer,
    callback: super::forward::Callback,
    head: Vec<u8>,
    cancel: CancellationToken,
) -> Result<String, HttpError> {
    let target = SshTarget::of(computer).await?;
    let shell = Shell::of(&computer.os);
    let command = match callback {
        super::forward::Callback::Port(port) => remote_command::loopback(shell, port),
        super::forward::Callback::Socket => remote_command::callback(shell),
    };
    let args = target.arguments("yes", &[], &command)?;
    let output = ssh::run(
        args,
        ssh::Stdin::Bytes(head),
        Duration::from_secs(90),
        cancel,
    )
    .await?;
    if output.exit_code != Some(0) {
        return Err(remote_error(
            "remote_loopback_failed",
            "Could not forward the sign-in callback.",
        ));
    }
    Ok(output.stdout)
}
