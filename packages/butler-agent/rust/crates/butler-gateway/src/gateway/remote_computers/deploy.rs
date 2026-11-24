//! Place the main's exact release and start the remote only when it is idle.
use super::{Computer, HostInput, HttpError, remote_error, ssh, store::KnownHosts};
use butler_platform::{hook_process::HookOutput, launcher::release_platform_for};
use butler_runtime::operations::{fetch_verified, release_artifact};
use std::{path::Path, time::Duration};
use tokio_util::sync::CancellationToken;

pub(super) struct RemoteState {
    pub version: String,
    pub started: bool,
}

const SCRIPT: &str = r#"set -eu
umask 077
F=$4
case "$F" in
    '~') F="$HOME" ;;
    '~/'*) F="$HOME/${F#??}" ;;
esac
if [ "$(cd -- "$F" && pwd -P)" = "$(cd -- "$HOME" && pwd -P)" ]; then
    echo state=home_folder
    exit 0
fi
R="$HOME/.butler-remote"
mkdir -p "$R/versions"
if [ "$(uname -s)" = Linux ]; then P=$(cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || echo 0); if [ "$P" -lt 1 ] 2>/dev/null || [ -z "$P" ]; then echo state=unprotected; exit 0; fi; fi
rm -rf "$R"/versions/.download-* "$R"/versions/.staging-*; [ -n "${UPLOADED:-}" ] || rm -f "$R"/versions/.upload-*
V=$1
SHA=$2
URL=$3
SHORT=$(printf '%s' "$SHA" | cut -c1-8)
DEST="versions/$V-$SHORT"
CURRENT=$(readlink "$R/current" || true)
if [ "$CURRENT" = "$DEST" ]; then
    if "$R/current/butler-agent" status --json --data "$R/data" | grep -q '"status": *"offline"'; then
        "$R/current/butler-agent" start --remote --data "$R/data" --json >/dev/null
    fi
    echo "state=ready version=$V"
    exit 0
fi
if [ -x "$R/current/butler-agent" ]; then
    if ! "$R/current/butler-agent" status --json --data "$R/data" | grep -q '"status": *"offline"'; then
        RUNNING=${CURRENT#versions/}
        echo "state=busy version=${RUNNING%-*}"
        exit 0
    fi
fi
ARCHIVE="$R/versions/.download-$SHORT"
if [ -n "${UPLOADED:-}" ]; then
    ARCHIVE="$R/$UPLOADED"
elif [ -z "$URL" ]; then
    echo state=need_upload; exit 0
elif command -v curl >/dev/null 2>&1; then
    if ! curl -fsSL "$URL" > "$ARCHIVE"; then rm -f "$ARCHIVE"; echo state=need_upload; exit 0; fi
elif command -v wget >/dev/null 2>&1; then
    if ! wget -qO- "$URL" > "$ARCHIVE"; then rm -f "$ARCHIVE"; echo state=need_upload; exit 0; fi
else
    echo state=need_upload; exit 0
fi
if command -v sha256sum >/dev/null 2>&1; then
    DIGEST=$(sha256sum "$ARCHIVE") || { rm -f "$ARCHIVE"; echo state=need_upload; exit 0; }
else
    DIGEST=$(shasum -a 256 "$ARCHIVE") || { rm -f "$ARCHIVE"; echo state=need_upload; exit 0; }
fi
if [ "${DIGEST%% *}" != "$SHA" ]; then
    rm -f "$ARCHIVE"; echo state=need_upload; exit 0
fi
if [ ! -d "$R/$DEST" ]; then
    STAGING="$R/versions/.staging-$SHORT"
    mkdir "$STAGING"
    tar -xzf "$ARCHIVE" -C "$STAGING"
    grep -q '"version": *"'"$V"'"' "$STAGING/native-agent-manifest.json"
    mv "$STAGING" "$R/$DEST"
fi
rm -f "$ARCHIVE"
ln -sfn "$DEST" "$R/current.tmp" && (mv -fT "$R/current.tmp" "$R/current" 2>/dev/null || mv -fh "$R/current.tmp" "$R/current")
for OLD in "$R"/versions/*; do
    if [ "$OLD" != "$R/$DEST" ]; then rm -rf "$OLD"; fi
done
"$R/current/butler-agent" start --remote --data "$R/data" --json >/dev/null
echo "state=ready version=$V"
"#;

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
    let known_hosts = KnownHosts::write(computer.host_keys.iter().cloned().collect()).await?;
    let target = HostInput {
        address: computer.address.clone(),
        port: computer.port.map(i64::from),
        key_file: computer.key_file.clone(),
    };
    let home = butler_platform::user_dirs::non_empty_home_dir();
    let quote = |value: &str| format!("'{}'", value.replace('\'', "'\\''"));
    let command = format!(
        "sh -s -- {} {} {} {}",
        quote(version),
        quote(&sha),
        quote(if loopback { "" } else { &url }),
        quote(&computer.folder)
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
        args.clone(),
        ssh::Stdin::Bytes(SCRIPT.as_bytes().to_vec()),
        Duration::from_mins(10),
        cancel.clone(),
    )
    .await?;
    let state = response(&output)?;
    if state != "state=need_upload" {
        return ready(&state);
    }
    let directory = root.join(format!("remote-download-{}", uuid::Uuid::new_v4()));
    let result = upload(&client, &directory, &url, &sha, args, cancel).await;
    let _ = tokio::fs::remove_dir_all(&directory).await;
    result
}

async fn upload(
    client: &butler_log::http::Client,
    directory: &Path,
    url: &str,
    sha: &str,
    args: Vec<String>,
    cancel: CancellationToken,
) -> Result<RemoteState, HttpError> {
    let archive = fetch_verified(client, &cancel, url, sha, directory)
        .await
        .map_err(|error| {
            if error.code() == "update_artifact_sha256_mismatch" {
                remote_error("checksum_mismatch", "Release checksum does not match.")
            } else {
                remote_error("release_download_failed", "Release download failed.")
            }
        })?;
    let path = format!("versions/.upload-{}", &sha[..8]);
    let mut upload_args = args.clone();
    *upload_args.last_mut().ok_or(HttpError::Internal)? = format!(
        "umask 077; mkdir -p \"$HOME/.butler-remote/versions\" && cat > \"$HOME/.butler-remote/{path}\""
    );
    let output = ssh::run(
        upload_args,
        ssh::Stdin::File(archive),
        Duration::from_mins(30),
        cancel.clone(),
    )
    .await?;
    check_exit(&output)?;
    let script = format!("UPLOADED='{path}'\n{SCRIPT}");
    let output = ssh::run(
        args,
        ssh::Stdin::Bytes(script.into_bytes()),
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
    Err(remote_error("remote_start_failed", "Remote start failed."))
}

pub(super) async fn installed(
    computer: &Computer,
    cancel: CancellationToken,
) -> Result<bool, HttpError> {
    let known_hosts = KnownHosts::write(computer.host_keys.iter().cloned().collect()).await?;
    let target = HostInput {
        address: computer.address.clone(),
        port: computer.port.map(i64::from),
        key_file: computer.key_file.clone(),
    };
    let home = butler_platform::user_dirs::non_empty_home_dir();
    let args = ssh::arguments(
        &target,
        &known_hosts.0,
        "yes",
        &[],
        r#"test -x "$HOME/.butler-remote/current/butler-agent""#,
        home.as_deref(),
    )?;
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
    let known_hosts = KnownHosts::write(computer.host_keys.iter().cloned().collect()).await?;
    let target = HostInput {
        address: computer.address.clone(),
        port: computer.port.map(i64::from),
        key_file: computer.key_file.clone(),
    };
    let home = butler_platform::user_dirs::non_empty_home_dir();
    let args = ssh::arguments(
        &target,
        &known_hosts.0,
        "yes",
        &[],
        "sh -s",
        home.as_deref(),
    )?;
    let script = br#"set -eu
umask 077
R="$HOME/.butler-remote"
if [ -x "$R/current/butler-agent" ]; then
    "$R/current/butler-agent" stop --data "$R/data" --json >/dev/null
fi
rm -rf "$R"
"#;
    let output = ssh::run(
        args,
        ssh::Stdin::Bytes(script.to_vec()),
        Duration::from_mins(10),
        cancel,
    )
    .await?;
    check_exit(&output)
}
