//! Place the main's exact release and start the remote only when it is idle.
use super::{
    Computer, HttpError,
    remote_command::{self, Shell},
    remote_error, ssh,
    target::SshTarget,
};
use butler_platform::{hook_process::HookOutput, launcher::release_platform_for};
use butler_runtime::operations::{fetch_verified, release_artifact};
use std::{path::Path, time::Duration};
use tokio_util::sync::CancellationToken;

pub(super) struct RemoteState {
    pub version: String,
    pub started: bool,
}

pub(super) async fn ensure_running(
    data: (&Path, &str),
    computer: &Computer,
    cancel: CancellationToken,
) -> Result<RemoteState, HttpError> {
    let (root, version) = data;
    let platform = release_platform_for(&computer.os, &computer.arch)
        .ok_or_else(|| remote_error("unsupported_computer", "Unsupported computer."))?;
    let base = std::env::var("BUTLER_REMOTE_RELEASE_BASE")
        .unwrap_or_else(|_| "https://github.com/Hexpy-Games/butler/releases/download".into());
    let manifest = format!(
        "{}/v{version}/agent-update-manifest.json",
        base.trim_end_matches('/')
    );
    let client = butler_log::http::external(butler_log::http::Purpose::new("update"))
        .build()
        .map_err(|_| remote_error("release_not_found", "Release unavailable."))?;
    let (url, sha) = release_artifact(&client, &cancel, &manifest, platform, version)
        .await
        .map_err(|_| remote_error("release_not_found", "Release unavailable."))?;
    let parsed = url::Url::parse(&url)
        .map_err(|_| remote_error("release_download_failed", "Invalid release URL."))?;
    let loopback = parsed.host().is_some_and(|host| match host {
        url::Host::Domain(host) => host == "localhost",
        url::Host::Ipv4(ip) => ip.is_loopback(),
        url::Host::Ipv6(ip) => ip.is_loopback(),
    });
    if parsed.scheme() != "https" && !loopback {
        return Err(remote_error(
            "release_download_failed",
            "Invalid release URL.",
        ));
    }
    let target = SshTarget::of(computer).await?;
    let shell = Shell::of(&computer.os);
    let values = remote_command::Deploy {
        version,
        sha: &sha,
        url: if loopback { "" } else { &url },
        folder: &computer.folder,
    };
    let remote = remote_command::deploy(shell, &values, None);
    let args = target.arguments("yes", &[], &remote.command)?;
    let output = ssh::run(
        args.clone(),
        ssh::Stdin::Bytes(remote.stdin),
        Duration::from_mins(10),
        cancel.clone(),
    )
    .await?;
    let state = response(&output)?;
    if state != "state=need_upload" {
        return ready(&state);
    }
    let directory = root.join(format!("remote-download-{}", uuid::Uuid::new_v4()));
    let result = upload(&client, &directory, &url, (shell, &values), args, cancel).await;
    let _ = tokio::fs::remove_dir_all(&directory).await;
    result
}

async fn upload(
    client: &butler_log::http::Client,
    directory: &Path,
    url: &str,
    (shell, values): (Shell, &remote_command::Deploy<'_>),
    args: Vec<String>,
    cancel: CancellationToken,
) -> Result<RemoteState, HttpError> {
    let archive = fetch_verified(client, &cancel, url, values.sha, directory)
        .await
        .map_err(|error| {
            if error.code() == "update_artifact_sha256_mismatch" {
                remote_error("checksum_mismatch", "Release checksum does not match.")
            } else {
                remote_error("release_download_failed", "Release download failed.")
            }
        })?;
    let (command, uploaded) = remote_command::upload(shell, &values.sha[..8]);
    let mut upload_args = args.clone();
    *upload_args.last_mut().ok_or(HttpError::Internal)? = command;
    let output = ssh::run(
        upload_args,
        ssh::Stdin::File(archive),
        Duration::from_mins(30),
        cancel.clone(),
    )
    .await?;
    check_exit(&output)?;
    let remote = remote_command::deploy(shell, values, Some(&uploaded));
    let output = ssh::run(
        args,
        ssh::Stdin::Bytes(remote.stdin),
        Duration::from_mins(10),
        cancel,
    )
    .await?;
    ready(&response(&output)?)
}

pub(super) fn check_exit(output: &HookOutput) -> Result<(), HttpError> {
    if output.exit_code == Some(255) {
        return Err(if output.stderr.contains("Permission denied") {
            remote_error("ssh_auth_failed", "SSH key login failed.")
        } else if output.stderr.contains("Host key verification failed") {
            remote_error("host_key_changed", "This computer's host key changed.")
        } else {
            remote_error("ssh_unreachable", "Could not reach this computer.")
        });
    }
    if output.exit_code != Some(0) {
        return Err(remote_error(
            "remote_start_failed",
            "Remote command failed.",
        ));
    }
    Ok(())
}

fn response(output: &HookOutput) -> Result<String, HttpError> {
    check_exit(output)?;
    output
        .stdout
        .lines()
        .find(|line| line.starts_with("state="))
        .map(str::to_owned)
        .ok_or_else(|| remote_error("remote_start_failed", "Remote command returned no state."))
}

fn ready(line: &str) -> Result<RemoteState, HttpError> {
    if line == "state=home_folder" {
        return Err(HttpError::public(
            422,
            "project_folder_unsafe",
            "Choose a folder inside your home folder.",
        ));
    }
    if line == "state=unprotected" {
        return Err(remote_error(
            "unsupported_computer",
            "Memory protection is off on this computer.",
        ));
    }
    if let Some((state, version)) = line.split_once(" version=")
        && matches!(state, "state=ready" | "state=busy")
    {
        return Ok(RemoteState {
            version: version.to_owned(),
            started: state == "state=ready",
        });
    }
    if line == "state=breakaway_denied" {
        return Err(remote_error(
            "remote_start_failed",
            "This computer's SSH server stops Butler on disconnect.",
        ));
    }
    Err(remote_error("remote_start_failed", "Remote start failed."))
}

pub(super) async fn installed(
    computer: &Computer,
    cancel: CancellationToken,
) -> Result<bool, HttpError> {
    let target = SshTarget::of(computer).await?;
    let command = remote_command::installed(Shell::of(&computer.os));
    let args = target.arguments("yes", &[], &command)?;
    let output = ssh::run(
        args,
        ssh::Stdin::Bytes(Vec::new()),
        Duration::from_secs(10),
        cancel,
    )
    .await?;
    if output.exit_code == Some(1) {
        return Ok(false);
    }
    check_exit(&output)?;
    Ok(true)
}

pub(super) async fn remove(
    computer: &Computer,
    cancel: CancellationToken,
) -> Result<(), HttpError> {
    let target = SshTarget::of(computer).await?;
    let remote = remote_command::remove(Shell::of(&computer.os));
    let args = target.arguments("yes", &[], &remote.command)?;
    let output = ssh::run(
        args,
        ssh::Stdin::Bytes(remote.stdin),
        Duration::from_mins(10),
        cancel,
    )
    .await?;
    check_exit(&output)
}
