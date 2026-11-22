use super::{
    Computer, HostInput, HttpError, remote_error,
    store::{KnownHosts, host_lines},
};
use butler_platform::{
    hook_process::{self, HookOutput, HookProcess, HookProcessError, StreamingProcess},
    remote_ssh,
};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

pub(super) enum Stdin {
    Bytes(Vec<u8>),
    File(PathBuf),
}

pub(super) struct HostKey {
    pub fingerprint: Option<String>,
    pub key_type: Option<String>,
    pub host_keys: Vec<String>,
}

fn identity_args(target: &HostInput, home: Option<&Path>) -> Result<Vec<String>, HttpError> {
    let mut args = Vec::new();
    if let Some(port) = target.port {
        args.extend(["-p".into(), port.to_string()]);
    }
    if let Some(key) = &target.key_file {
        let key =
            butler_platform::tool_paths::expand_home(key, home).map_err(|_| HttpError::Internal)?;
        args.extend(["-i".into(), key, "-o".into(), "IdentitiesOnly=yes".into()]);
    }
    Ok(args)
}

pub(super) fn arguments(
    target: &HostInput,
    known_hosts: &Path,
    mode: &str,
    extra: &[&str],
    command: &str,
    home: Option<&Path>,
) -> Result<Vec<String>, HttpError> {
    let mut args = vec![remote_ssh::PROGRAM.into()];
    for option in [
        "BatchMode=yes",
        "ConnectTimeout=10",
        "NumberOfPasswordPrompts=0",
        "ForwardAgent=no",
        "ForwardX11=no",
        "ClearAllForwardings=yes",
        "PermitLocalCommand=no",
        "RequestTTY=no",
        "RemoteCommand=none",
        "ControlMaster=no",
        "ControlPath=none",
        "UpdateHostKeys=no",
        "GlobalKnownHostsFile=none",
    ] {
        args.extend(["-o".into(), option.into()]);
    }
    args.extend([
        "-o".into(),
        format!("UserKnownHostsFile={}", known_hosts.display()),
        "-o".into(),
        format!("StrictHostKeyChecking={mode}"),
    ]);
    args.extend(identity_args(target, home)?);
    for option in extra {
        args.extend(["-o".into(), (*option).into()]);
    }
    args.extend(["--".into(), target.address.clone(), command.into()]);
    Ok(args)
}

pub(super) async fn run(
    args: Vec<String>,
    stdin: Stdin,
    timeout: Duration,
    cancel: CancellationToken,
) -> Result<HookOutput, HttpError> {
    let (stdin, stdin_file) = match stdin {
        Stdin::Bytes(bytes) => (bytes, None),
        Stdin::File(path) => (Vec::new(), Some(path)),
    };
    Box::pin(hook_process::run(
        HookProcess {
            command: None,
            args: Some(args),
            environment: remote_ssh::environment(),
            cwd: std::env::temp_dir(),
            stdin,
            stdin_file,
            timeout,
            stdout_limit: hook_process::CONTEXT_OUTPUT_LIMIT,
        },
        cancel,
    ))
    .await
    .map_err(spawn_error)
}

fn spawn_error(error: HookProcessError) -> HttpError {
    match error {
        HookProcessError::Process(message) if message.contains("(os error 2)") => {
            remote_error("ssh_client_missing", "OpenSSH is not installed.")
        }
        _ => remote_error("ssh_unreachable", "Could not reach this computer."),
    }
}

pub(super) async fn spawn(args: Vec<String>) -> Result<StreamingProcess, HttpError> {
    hook_process::spawn_streaming(
        args,
        remote_ssh::environment(),
        std::env::temp_dir(),
        Vec::new(),
    )
    .await
    .map_err(spawn_error)
}

pub(super) async fn host_key(
    target: &HostInput,
    records: &[Computer],
    cancel: CancellationToken,
) -> Result<HostKey, HttpError> {
    let before = host_lines(records);
    let known_hosts = KnownHosts::write(before.clone()).await?;
    let home = butler_platform::user_dirs::non_empty_home_dir();
    let args = arguments(
        target,
        &known_hosts.0,
        "accept-new",
        &["PreferredAuthentications=none"],
        "true",
        home.as_deref(),
    )?;
    let output = run(
        args,
        Stdin::Bytes(Vec::new()),
        Duration::from_secs(20),
        cancel.clone(),
    )
    .await?;
    if output
        .stderr
        .contains("REMOTE HOST IDENTIFICATION HAS CHANGED")
        || output.stderr.contains("Host key verification failed")
    {
        return Err(remote_error(
            "host_key_changed",
            "This computer's host key changed.",
        ));
    }
    let after = known_hosts.lines().await?;
    let new_lines = after
        .difference(&before)
        .cloned()
        .collect::<std::collections::BTreeSet<_>>();
    let (fingerprint, key_type) = if !new_lines.is_empty() {
        fingerprint(new_lines, cancel.clone()).await?
    } else if output.exit_code == Some(255)
        && [
            "Could not resolve",
            "Connection refused",
            "Connection timed out",
            "No route to host",
            "Network is unreachable",
            "Operation timed out",
        ]
        .iter()
        .any(|message| output.stderr.contains(message))
    {
        return Err(remote_error(
            "ssh_unreachable",
            "Could not reach this computer.",
        ));
    } else {
        (None, None)
    };
    let host_keys = lookup(target, &known_hosts, home.as_deref(), cancel).await?;
    Ok(HostKey {
        fingerprint,
        key_type,
        host_keys,
    })
}

async fn fingerprint(
    new_lines: std::collections::BTreeSet<String>,
    cancel: CancellationToken,
) -> Result<(Option<String>, Option<String>), HttpError> {
    let new_hosts = KnownHosts::write(new_lines).await?;
    let output = run(
        vec![
            "ssh-keygen".into(),
            "-l".into(),
            "-E".into(),
            "sha256".into(),
            "-f".into(),
            new_hosts.0.to_string_lossy().into_owned(),
        ],
        Stdin::Bytes(Vec::new()),
        Duration::from_secs(20),
        cancel.clone(),
    )
    .await?;
    let line = output.stdout.lines().next().ok_or(HttpError::Internal)?;
    let fingerprint = line
        .split_whitespace()
        .nth(1)
        .ok_or(HttpError::Internal)?
        .to_owned();
    let key_type = line
        .split_whitespace()
        .last()
        .and_then(|s| s.strip_prefix('('))
        .and_then(|s| s.strip_suffix(')'))
        .ok_or(HttpError::Internal)?
        .to_owned();
    Ok((Some(fingerprint), Some(key_type)))
}

async fn lookup(
    target: &HostInput,
    known_hosts: &KnownHosts,
    home: Option<&Path>,
    cancel: CancellationToken,
) -> Result<Vec<String>, HttpError> {
    let mut args = vec![remote_ssh::PROGRAM.into(), "-G".into()];
    args.extend(identity_args(target, home)?);
    args.extend(["--".into(), target.address.clone()]);
    let config = run(
        args,
        Stdin::Bytes(Vec::new()),
        Duration::from_secs(20),
        cancel.clone(),
    )
    .await?;
    let mut hostname = "";
    let mut port = "22";
    let mut alias = "";
    for line in config.stdout.lines() {
        if let Some((key, value)) = line.split_once(' ') {
            match key {
                "hostname" => hostname = value.trim(),
                "port" => port = value.trim(),
                "hostkeyalias" => alias = value.trim(),
                _ => {}
            }
        }
    }
    let lookup = if !alias.is_empty() {
        alias.to_owned()
    } else if port == "22" {
        hostname.to_owned()
    } else {
        format!("[{hostname}]:{port}")
    };
    let output = run(
        vec![
            "ssh-keygen".into(),
            "-F".into(),
            lookup,
            "-f".into(),
            known_hosts.0.to_string_lossy().into_owned(),
        ],
        Stdin::Bytes(Vec::new()),
        Duration::from_secs(20),
        cancel,
    )
    .await?;
    Ok(output
        .stdout
        .lines()
        .filter(|line| !line.starts_with('#') && !line.is_empty())
        .map(str::to_owned)
        .collect())
}

pub(super) async fn probe(
    target: &HostInput,
    folder: &str,
    records: &[Computer],
    new_lines: &[String],
    cancel: CancellationToken,
) -> Result<Platform, HttpError> {
    let mut lines = host_lines(records);
    lines.extend(new_lines.iter().cloned());
    let known_hosts = KnownHosts::write(lines).await?;
    let home = butler_platform::user_dirs::non_empty_home_dir();
    let args = arguments(target, &known_hosts.0, "yes", &[], "sh -s", home.as_deref())?;
    let quote = |value: &str| format!("'{}'", value.replace('\'', "'\\''"));
    let folder = if folder == "~" {
        "\"$HOME\"".into()
    } else if let Some(rest) = folder.strip_prefix("~/") {
        format!("\"$HOME\"/{}", quote(rest))
    } else {
        quote(folder)
    };
    let script = format!(
        r#"echo "os=$(uname -s)"
echo "arch=$(uname -m)"
echo "glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null)"
echo "ptrace=$(cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null)"
echo "kill=$(busctl get-property org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager KillUserProcesses 2>/dev/null)"
if cd -- {folder} 2>/dev/null; then echo folder=ok; else echo folder=missing; fi
"#
    );
    let output = run(
        args,
        Stdin::Bytes(script.into_bytes()),
        Duration::from_secs(20),
        cancel,
    )
    .await?;
    if output.exit_code == Some(255) {
        return Err(if output.stderr.contains("Permission denied") {
            remote_error("ssh_auth_failed", "SSH key login failed.")
        } else if output.stderr.contains("Host key verification failed") {
            remote_error("host_key_changed", "This computer's host key changed.")
        } else {
            remote_error("ssh_unreachable", "Could not reach this computer.")
        });
    }
    let platform = platform(&output.stdout).map_err(|raw| {
        remote_error(
            "unsupported_computer",
            &format!(
                "Unsupported computer: os={}, arch={}, glibc={}, ptrace={}.",
                raw.os, raw.arch, raw.glibc, raw.ptrace
            ),
        )
    })?;
    if !platform.folder_ok {
        return Err(remote_error(
            "computer_folder_missing",
            "The work folder does not exist.",
        ));
    }
    Ok(platform)
}

#[derive(Debug)]
pub(super) struct Platform {
    pub os: String,
    pub arch: String,
    pub glibc: Option<String>,
    pub stops_on_logout: bool,
    pub folder_ok: bool,
}

#[derive(Debug)]
struct Unsupported {
    os: String,
    arch: String,
    glibc: String,
    ptrace: String,
}

fn platform(probe: &str) -> Result<Platform, Unsupported> {
    let values: std::collections::HashMap<_, _> = probe
        .lines()
        .filter_map(|line| line.split_once('='))
        .collect();
    let os = values.get("os").copied().unwrap_or_default();
    let arch = values.get("arch").copied().unwrap_or_default();
    let glibc = values.get("glibc").copied().unwrap_or_default();
    let version = glibc.strip_prefix("glibc ");
    let supported_glibc = version
        .and_then(|v| v.split_once('.'))
        .and_then(|(major, minor)| Some((major.parse::<u32>().ok()?, minor.parse::<u32>().ok()?)))
        .is_some_and(|version| version >= (2, 39));
    let ptrace = values.get("ptrace").copied().unwrap_or_default();
    let supported_linux = supported_glibc && ptrace.parse::<u32>().is_ok_and(|scope| scope >= 1);
    let (os, arch, glibc) = match (os, arch) {
        ("Darwin", "arm64") => ("macos", "arm64", None),
        ("Linux", "x86_64") if supported_linux => ("linux", "x64", version.map(str::to_owned)),
        ("Linux", "aarch64" | "arm64") if supported_linux => {
            ("linux", "arm64", version.map(str::to_owned))
        }
        _ => {
            return Err(Unsupported {
                os: os.into(),
                arch: arch.into(),
                glibc: glibc.into(),
                ptrace: ptrace.into(),
            });
        }
    };
    Ok(Platform {
        os: os.into(),
        arch: arch.into(),
        glibc,
        stops_on_logout: values.get("kill") == Some(&"b true"),
        folder_ok: values.get("folder") == Some(&"ok"),
    })
}
