use super::{
    Computer, HostInput, HttpError,
    askpass::Askpass,
    connection_error,
    probe::{self, Platform},
    remote_command::{self, Remote, Shell},
    remote_error,
    ssh::{self, HostCheck},
    ssh_key,
    store::KnownHosts,
};
use butler_platform::{
    hook_process::HookOutput, powershell_text::decoded, process_names, remote_ssh,
};
use std::{collections::BTreeSet, path::Path, time::Duration};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

const INSTALL: &[u8] = br#"set -eu
case "$(uname -s)" in Darwin|Linux) ;; *) exit 90 ;; esac
umask 077
d="$HOME/.ssh"; f="$d/authorized_keys"; b=$(printf '%s' "$1" | awk '{print $2}')
[ -d "$d" ] || mkdir -m 700 "$d"
[ -f "$f" ] || : > "$f"
if awk -v b="$b" '{for(i=1;i<=NF;i++) if($i==b) f=1} END{exit !f}' "$f"; then echo state=present; else
  if [ -s "$f" ] && [ -n "$(tail -c 1 "$f")" ]; then printf '\n' >> "$f"; fi
  printf '%s\n' "$1" >> "$f"; echo state=added; fi
if command -v restorecon >/dev/null 2>&1; then restorecon -F "$d" "$f" >/dev/null 2>&1 || true; fi
"#;

const REMOVE: &[u8] = br#"set -eu
f="$HOME/.ssh/authorized_keys"; [ -f "$f" ] || exit 0
umask 077; t="$f.butler.$$"
awk -v b="$1" '{for(i=1;i<=NF;i++) if($i==b) next; print}' "$f" > "$t"
cat "$t" > "$f"; rm -f "$t"
"#;

/// The authorized_keys file sshd reads for this user: the shared admin file when the
/// user is an administrator and sshd_config has an active `Match Group administrators`.
const KEY_FILE_PS: &str = r"$f=Join-Path $env:USERPROFILE '.ssh\authorized_keys'
$admin=$false
$cfg=Join-Path $env:ProgramData 'ssh\sshd_config'
if((New-Object Security.Principal.WindowsPrincipal ([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.SecurityIdentifier]'S-1-5-32-544') -and (Test-Path -LiteralPath $cfg) -and (Select-String -LiteralPath $cfg -Pattern '^\s*Match\s+Group\s+administrators\s*$' -Quiet)){$admin=$true;$f=Join-Path $env:ProgramData 'ssh\administrators_authorized_keys'}
";

const INSTALL_PS: &str = r#"$B=($K -split '\s+')[1]
$d=Split-Path -Parent $f
if(-not(Test-Path -LiteralPath $d)){New-Item -ItemType Directory -Path $d|Out-Null}
$t=if(Test-Path -LiteralPath $f){[IO.File]::ReadAllText($f)}else{''}
if(@($t -split "`r?`n"|Where-Object{($_.Trim() -split '\s+') -ccontains $B}).Count -gt 0){'state=present';exit 0}
$n=if($t.Length -gt 0 -and -not $t.EndsWith("`n")){"`r`n"}else{''}
[IO.File]::AppendAllText($f,$n+$K+"`r`n",(New-Object Text.UTF8Encoding $false))
if($admin -and (Run (Join-Path $env:SystemRoot 'System32\icacls.exe') ((Q $f)+' /inheritance:r /grant *S-1-5-32-544:F /grant *S-1-5-18:F')).Code -ne 0){
    $lines=[IO.File]::ReadAllLines($f)
    $keep=@($lines|Where-Object{-not(($_.Trim() -split '\s+') -ccontains $B)})
    if($keep.Count -ne $lines.Count){[IO.File]::WriteAllLines($f,[string[]]$keep,(New-Object Text.UTF8Encoding $false))}
    exit 1
}
'state=added'
"#;

const REMOVE_PS: &str = r"if(-not(Test-Path -LiteralPath $f)){exit 0}
$lines=[IO.File]::ReadAllLines($f)
$keep=@($lines|Where-Object{-not(($_.Trim() -split '\s+') -ccontains $B)})
if($keep.Count -ne $lines.Count){[IO.File]::WriteAllLines($f,[string[]]$keep,(New-Object Text.UTF8Encoding $false))}
";

#[derive(Clone, Copy)]
pub(super) enum Key {
    Install,
    Remove,
}

/// The key script for `shell`; `argument` is the public key line (install) or its blob (remove).
pub(super) fn key_command(shell: Shell, key: Key, argument: &str) -> Remote {
    match (shell, key) {
        (Shell::Posix, Key::Install) => Remote {
            command: command(argument),
            stdin: INSTALL.to_vec(),
        },
        (Shell::Posix, Key::Remove) => Remote {
            command: command(argument),
            stdin: REMOVE.to_vec(),
        },
        (Shell::PowerShell, Key::Install) => remote_command::script(&format!(
            "$K={}\n{}{}{KEY_FILE_PS}{INSTALL_PS}",
            decoded(argument),
            remote_command::QUOTE,
            remote_command::RUN
        )),
        (Shell::PowerShell, Key::Remove) => remote_command::script(&format!(
            "$B={}\n{KEY_FILE_PS}{REMOVE_PS}",
            decoded(argument)
        )),
    }
}

fn arguments(target: &HostInput, known_hosts: &Path, method: &str, command: &str) -> Vec<String> {
    let mut args = vec![remote_ssh::PROGRAM.into()];
    args.extend(remote_ssh::settings_config_args());
    for option in [
        "BatchMode=no",
        "NumberOfPasswordPrompts=1",
        "PubkeyAuthentication=no",
        "IdentitiesOnly=yes",
        "IdentityAgent=none",
        "GSSAPIAuthentication=no",
        "HostbasedAuthentication=no",
        "KbdInteractiveAuthentication=yes",
        "PasswordAuthentication=yes",
        &format!("PreferredAuthentications={method}"),
        "LogLevel=VERBOSE",
    ] {
        args.extend(["-o".into(), option.into()]);
    }
    args.extend(ssh::hardening(known_hosts, "yes"));
    if let Some(port) = target.port {
        args.extend(["-p".into(), port.to_string()]);
    }
    args.extend(["--".into(), target.address.clone(), command.into()]);
    args
}

fn method(check: &HostCheck) -> Result<&'static str, HttpError> {
    let offered = |method| check.methods.iter().any(|value| value == method);
    if !check.proxied {
        if check.methods.is_empty() || offered("password") {
            return Ok("password");
        }
        if offered("keyboard-interactive") {
            return Ok("keyboard-interactive");
        }
    }
    Err(remote_error(
        "ssh_password_not_allowed",
        "This computer doesn't accept password sign-in.",
    ))
}

fn classify(output: &HookOutput, requests: usize) -> Result<(), HttpError> {
    if output.stderr.contains("with partial success") || requests >= 2 {
        return Err(remote_error(
            "ssh_password_extra_step",
            "This computer needs another sign-in step.",
        ));
    }
    match output.exit_code {
        Some(0) => Ok(()),
        Some(90) => Err(remote_error(
            "unsupported_computer",
            "Unsupported computer.",
        )),
        Some(255) if output.stderr.contains("Permission denied") => {
            if requests == 0 {
                Err(install_failed())
            } else {
                Err(remote_error("ssh_password_wrong", "Wrong password."))
            }
        }
        Some(255) | None => Err(connection_error(&output.stderr)),
        _ => Err(install_failed()),
    }
}

pub(super) fn install_failed() -> HttpError {
    remote_error("ssh_key_install_failed", "Couldn't install the SSH key.")
}

async fn attempt(
    input: &HostInput,
    check: &HostCheck,
    method: &str,
    password: &Zeroizing<String>,
    remote: Remote,
    cancel: CancellationToken,
) -> Result<(HookOutput, usize), HttpError> {
    let known_hosts =
        KnownHosts::write(check.lines.iter().cloned().collect::<BTreeSet<_>>()).await?;
    let helper = process_names::current_exe().map_err(|_| install_failed())?;
    let askpass = Askpass::start(password.clone()).await?;
    let output = ssh::run_with_env(
        arguments(input, &known_hosts.0, method, &remote.command),
        ssh::Stdin::Bytes(remote.stdin),
        Duration::from_secs(30),
        cancel,
        remote_ssh::askpass_environment(&helper, &askpass.channel),
    )
    .await?;
    Ok((output, askpass.requests()))
}

/// The key script in `shell`, or when the shell is not known yet: in sh first,
/// then in PowerShell when sh's result says Windows (`remote_command::try_windows`).
async fn run(
    input: &HostInput,
    check: &HostCheck,
    method: &str,
    password: &Zeroizing<String>,
    (key, argument): (Key, &str),
    shell: Option<Shell>,
    cancel: CancellationToken,
) -> Result<(HookOutput, Shell), HttpError> {
    let first = shell.unwrap_or(Shell::Posix);
    let (output, requests) = attempt(
        input,
        check,
        method,
        password,
        key_command(first, key, argument),
        cancel.clone(),
    )
    .await?;
    if shell.is_none() && remote_command::try_windows(&output) {
        let (windows, requests) = attempt(
            input,
            check,
            method,
            password,
            key_command(Shell::PowerShell, key, argument),
            cancel,
        )
        .await?;
        if windows.exit_code != Some(127) {
            classify(&windows, requests)?;
            return Ok((windows, Shell::PowerShell));
        }
    }
    classify(&output, requests)?;
    Ok((output, first))
}

fn command(argument: &str) -> String {
    format!("sh -s -- '{}'", argument.replace('\'', "'\\''"))
}

pub(super) fn blob(public: &str) -> Result<&str, HttpError> {
    public.split_whitespace().nth(1).ok_or_else(install_failed)
}

pub(super) async fn install(
    input: &HostInput,
    check: &HostCheck,
    password: &Zeroizing<String>,
    cancel: CancellationToken,
) -> Result<(Option<String>, Shell), HttpError> {
    let method = method(check)?;
    let public = ssh_key::ensure(cancel.clone()).await?;
    let (output, shell) = run(
        input,
        check,
        method,
        password,
        (Key::Install, &public),
        None,
        cancel,
    )
    .await?;
    if output.stdout.lines().any(|line| line == "state=added") {
        Ok((Some(public), shell))
    } else if output.stdout.lines().any(|line| line == "state=present") {
        Ok((None, shell))
    } else {
        Err(install_failed())
    }
}

pub(super) async fn remove(
    input: &HostInput,
    check: &HostCheck,
    password: &Zeroizing<String>,
    public: &str,
    shell: Shell,
    cancel: CancellationToken,
) {
    if let (Ok(method), Ok(blob)) = (method(check), blob(public)) {
        let _ = run(
            input,
            check,
            method,
            password,
            (Key::Remove, blob),
            Some(shell),
            cancel,
        )
        .await;
    }
}

pub(super) struct Install {
    password: Option<Zeroizing<String>>,
    added: Option<String>,
    shell: Shell,
}

impl Install {
    pub(super) async fn start(
        input: &HostInput,
        check: &HostCheck,
        password: Option<Zeroizing<String>>,
        cancel: CancellationToken,
    ) -> Result<Self, HttpError> {
        let (added, shell) = if let Some(password) = &password {
            install(input, check, password, cancel).await?
        } else {
            (None, Shell::Posix)
        };
        Ok(Self {
            password,
            added,
            shell,
        })
    }

    pub(super) fn added(&self) -> bool {
        self.added.is_some()
    }

    pub(super) async fn rollback(&self, input: &HostInput, check: &HostCheck) {
        if let (Some(password), Some(public)) = (&self.password, &self.added) {
            remove(
                input,
                check,
                password,
                public,
                self.shell,
                CancellationToken::new(),
            )
            .await;
        }
    }

    pub(super) async fn probe(
        &self,
        input: &HostInput,
        folder: &str,
        records: &[Computer],
        lines: &[String],
        managed_key: bool,
        cancel: CancellationToken,
    ) -> Result<Platform, HttpError> {
        let mut target = input.clone();
        let result = async {
            let _key = if managed_key && target.identity.is_none() {
                Some(ssh_key::managed_target(&mut target).await?)
            } else {
                None
            };
            probe::probe(&target, folder, records, lines, cancel).await
        }
        .await;
        match result {
            Err(HttpError::Public { ref code, .. })
                if self.password.is_some() && code == "ssh_auth_failed" =>
            {
                Err(install_failed())
            }
            _ => result,
        }
    }
}
