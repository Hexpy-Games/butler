use super::{
    Computer, HostInput, HttpError, remote_error,
    store::{KnownHosts, host_lines},
};
use butler_platform::{
    hook_process::{self, HookOutput, HookProcess, HookProcessError, StreamingProcess},
    remote_ssh,
};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

pub(super) enum Stdin {
    Bytes(Vec<u8>),
    File(PathBuf),
}

fn identity_args(target: &HostInput, home: Option<&Path>) -> Result<Vec<String>, HttpError> {
    let mut args = Vec::new();
    if let Some(port) = target.port {
        args.extend(["-p".into(), port.to_string()]);
    }
    let key = if let Some(path) = &target.identity {
        Some(path.to_string_lossy().into_owned())
    } else {
        target
            .key_file
            .as_ref()
            .map(|key| {
                butler_platform::tool_paths::expand_home(key, home).map_err(|_| HttpError::Internal)
            })
            .transpose()?
    };
    if let Some(key) = key {
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
    args.extend(remote_ssh::settings_config_args());
    args.extend(["-o", "BatchMode=yes", "-o", "NumberOfPasswordPrompts=0"].map(str::to_owned));
    args.extend(hardening(known_hosts, mode));
    args.extend(identity_args(target, home)?);
    for option in extra {
        args.extend(["-o".into(), (*option).into()]);
    }
    args.extend(["--".into(), target.address.clone(), command.into()]);
    Ok(args)
}

pub(super) fn hardening(known_hosts: &Path, mode: &str) -> Vec<String> {
    let mut args = Vec::new();
    for option in [
        "ConnectTimeout=10",
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
    args
}

pub(super) async fn run(
    args: Vec<String>,
    stdin: Stdin,
    timeout: Duration,
    cancel: CancellationToken,
) -> Result<HookOutput, HttpError> {
    run_with_env(args, stdin, timeout, cancel, remote_ssh::environment()).await
}

pub(super) async fn run_with_env(
    args: Vec<String>,
    stdin: Stdin,
    timeout: Duration,
    cancel: CancellationToken,
    environment: HashMap<String, String>,
) -> Result<HookOutput, HttpError> {
    let (stdin, stdin_file) = match stdin {
        Stdin::Bytes(bytes) => (bytes, None),
        Stdin::File(path) => (Vec::new(), Some(path)),
    };
    Box::pin(hook_process::run(
        HookProcess {
            command: None,
            args: Some(args),
            environment,
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

pub(super) struct HostCheck {
    pub lines: Vec<String>,
    pub methods: Vec<String>,
    pub proxied: bool,
}

pub(super) async fn host_key(
    target: &HostInput,
    records: &[Computer],
    cancel: CancellationToken,
) -> Result<HostCheck, HttpError> {
    let before = host_lines(records);
    let known_hosts = KnownHosts::write(before.clone()).await?;
    let home = butler_platform::user_dirs::non_empty_home_dir();
    let args = arguments(
        target,
        &known_hosts.0,
        "accept-new",
        &["PreferredAuthentications=none", "LogLevel=ERROR"],
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
    let new_lines: Vec<String> = after.difference(&before).cloned().collect();
    if new_lines.is_empty()
        && output.exit_code == Some(255)
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
    }
    let settings = settings(target, home.as_deref(), cancel.clone()).await?;
    if !new_lines.is_empty()
        && !accepts(&new_lines, &user_entries(&settings, cancel.clone()).await?)
    {
        return Err(remote_error(
            "host_key_changed",
            "This computer's host key changed.",
        ));
    }
    let methods = output
        .stderr
        .split_once("Permission denied (")
        .and_then(|(_, rest)| rest.split_once(")."))
        .map_or_else(Vec::new, |(methods, _)| {
            methods
                .split(',')
                .map(str::trim)
                .filter(|method| !method.is_empty())
                .map(str::to_owned)
                .collect()
        });
    Ok(HostCheck {
        lines: lookup(&settings.lookup, &known_hosts, cancel).await?,
        methods,
        proxied: settings.proxied,
    })
}

struct Settings {
    lookup: String,
    files: Vec<String>,
    proxied: bool,
}

async fn settings(
    target: &HostInput,
    home: Option<&Path>,
    cancel: CancellationToken,
) -> Result<Settings, HttpError> {
    let mut args = vec![remote_ssh::PROGRAM.into()];
    args.extend(remote_ssh::settings_config_args());
    args.push("-G".into());
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
    let mut files = Vec::new();
    let mut proxied = false;
    for line in config.stdout.lines() {
        if let Some((key, value)) = line.split_once(' ') {
            match key {
                "hostname" => hostname = value.trim(),
                "port" => port = value.trim(),
                "hostkeyalias" => alias = value.trim(),
                "proxyjump" | "proxycommand" => proxied |= !matches!(value.trim(), "" | "none"),
                "userknownhostsfile" | "globalknownhostsfile" => {
                    for file in value.split_whitespace().filter(|file| *file != "none") {
                        if !Path::new(file).is_absolute() {
                            return Err(HttpError::Internal);
                        }
                        files.push(file.to_owned());
                    }
                }
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
    Ok(Settings {
        lookup,
        files,
        proxied,
    })
}

async fn lookup(
    lookup: &str,
    known_hosts: &KnownHosts,
    cancel: CancellationToken,
) -> Result<Vec<String>, HttpError> {
    let output = run(
        vec![
            "ssh-keygen".into(),
            "-F".into(),
            lookup.into(),
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

async fn user_entries(
    settings: &Settings,
    cancel: CancellationToken,
) -> Result<Vec<String>, HttpError> {
    let mut entries = Vec::new();
    for file in &settings.files {
        if !tokio::fs::try_exists(file).await.unwrap_or(false) {
            continue;
        }
        let output = run(
            vec![
                "ssh-keygen".into(),
                "-F".into(),
                settings.lookup.clone(),
                "-f".into(),
                file.clone(),
            ],
            Stdin::Bytes(Vec::new()),
            Duration::from_secs(20),
            cancel.clone(),
        )
        .await?;
        entries.extend(
            output
                .stdout
                .lines()
                .filter(|line| !line.starts_with('#') && !line.trim().is_empty())
                .map(str::to_owned),
        );
    }
    Ok(entries)
}

fn accepts(scanned: &[String], entries: &[String]) -> bool {
    fn parse(line: &str) -> Option<(Option<&str>, &str, &str)> {
        let mut fields = line.split_whitespace();
        let first = fields.next()?;
        let marker = if first.starts_with('@') {
            fields.next()?;
            Some(first)
        } else {
            None
        };
        Some((marker, fields.next()?, fields.next()?))
    }
    let entries: Vec<_> = entries.iter().filter_map(|line| parse(line)).collect();
    scanned
        .iter()
        .filter_map(|line| parse(line))
        .all(|(_, kind, blob)| {
            if entries
                .iter()
                .any(|(marker, _, key)| *marker == Some("@revoked") && *key == blob)
            {
                return false;
            }
            let mut keys = entries
                .iter()
                .filter(|(marker, entry_kind, _)| marker.is_none() && *entry_kind == kind)
                .peekable();
            keys.peek().is_none() || keys.any(|(_, _, key)| *key == blob)
        })
}
