use super::{
    Computer, HostInput, HttpError, connection_error,
    remote_command::{self, Shell},
    remote_error,
    ssh::{self, Stdin},
    store::{KnownHosts, host_lines},
};
use butler_platform::hook_process::HookOutput;
use std::{path::Path, time::Duration};
use tokio_util::sync::CancellationToken;

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
    let mut output = run_probe(
        target,
        &known_hosts,
        home.as_deref(),
        remote_command::probe(Shell::Posix, folder),
        cancel.clone(),
    )
    .await?;
    if remote_command::try_windows(&output) {
        let windows = run_probe(
            target,
            &known_hosts,
            home.as_deref(),
            remote_command::probe(Shell::PowerShell, folder),
            cancel,
        )
        .await?;
        if windows.exit_code != Some(127) {
            output = windows;
        }
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

async fn run_probe(
    target: &HostInput,
    known_hosts: &KnownHosts,
    home: Option<&Path>,
    remote: remote_command::Remote,
    cancel: CancellationToken,
) -> Result<HookOutput, HttpError> {
    let args = ssh::arguments(target, &known_hosts.0, "yes", &[], &remote.command, home)?;
    let output = ssh::run(
        args,
        Stdin::Bytes(remote.stdin),
        Duration::from_secs(20),
        cancel,
    )
    .await?;
    if output.exit_code == Some(255) {
        return Err(if output.stderr.contains("Permission denied") {
            remote_error("ssh_auth_failed", "SSH key login failed.")
        } else {
            connection_error(&output.stderr)
        });
    }
    Ok(output)
}

#[derive(Clone, Debug)]
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
        ("Windows", "AMD64") => ("windows", "x64", None),
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
