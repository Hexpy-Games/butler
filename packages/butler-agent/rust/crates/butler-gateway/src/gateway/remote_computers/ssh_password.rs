use super::{
    Computer, HostInput, HttpError,
    askpass::Askpass,
    connection_error, remote_error,
    ssh::{self, HostCheck, Platform},
    ssh_key,
    store::KnownHosts,
};
use butler_platform::{hook_process::HookOutput, process_names, remote_ssh};
use std::{collections::BTreeSet, path::Path, time::Duration};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

pub(super) const INSTALL: &[u8] = br#"set -eu
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

pub(super) const REMOVE: &[u8] = br#"set -eu
f="$HOME/.ssh/authorized_keys"; [ -f "$f" ] || exit 0
umask 077; t="$f.butler.$$"
awk -v b="$1" '{for(i=1;i<=NF;i++) if($i==b) next; print}' "$f" > "$t"
cat "$t" > "$f"; rm -f "$t"
"#;

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

async fn run(
    input: &HostInput,
    check: &HostCheck,
    method: &str,
    password: &Zeroizing<String>,
    (script, argument): (&[u8], &str),
    cancel: CancellationToken,
) -> Result<HookOutput, HttpError> {
    let known_hosts =
        KnownHosts::write(check.lines.iter().cloned().collect::<BTreeSet<_>>()).await?;
    let command = command(argument);
    let helper = process_names::current_exe().map_err(|_| install_failed())?;
    let askpass = Askpass::start(password.clone()).await?;
    let output = ssh::run_with_env(
        arguments(input, &known_hosts.0, method, &command),
        ssh::Stdin::Bytes(script.to_vec()),
        Duration::from_secs(30),
        cancel,
        remote_ssh::askpass_environment(&helper, &askpass.channel),
    )
    .await?;
    classify(&output, askpass.requests())?;
    Ok(output)
}

pub(super) fn command(argument: &str) -> String {
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
) -> Result<Option<String>, HttpError> {
    let method = method(check)?;
    let public = ssh_key::ensure(cancel.clone()).await?;
    let output = run(input, check, method, password, (INSTALL, &public), cancel).await?;
    if output.stdout.lines().any(|line| line == "state=added") {
        Ok(Some(public))
    } else if output.stdout.lines().any(|line| line == "state=present") {
        Ok(None)
    } else {
        Err(install_failed())
    }
}

pub(super) async fn remove(
    input: &HostInput,
    check: &HostCheck,
    password: &Zeroizing<String>,
    public: &str,
    cancel: CancellationToken,
) {
    if let (Ok(method), Ok(blob)) = (method(check), blob(public)) {
        let _ = run(input, check, method, password, (REMOVE, blob), cancel).await;
    }
}

pub(super) struct Install {
    password: Option<Zeroizing<String>>,
    added: Option<String>,
}

impl Install {
    pub(super) async fn start(
        input: &HostInput,
        check: &HostCheck,
        password: Option<Zeroizing<String>>,
        cancel: CancellationToken,
    ) -> Result<Self, HttpError> {
        let added = if let Some(password) = &password {
            install(input, check, password, cancel).await?
        } else {
            None
        };
        Ok(Self { password, added })
    }

    pub(super) fn added(&self) -> bool {
        self.added.is_some()
    }

    pub(super) async fn rollback(&self, input: &HostInput, check: &HostCheck) {
        if let (Some(password), Some(public)) = (&self.password, &self.added) {
            remove(input, check, password, public, CancellationToken::new()).await;
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
            ssh::probe(&target, folder, records, lines, cancel).await
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
