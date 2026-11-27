//! The commands Butler runs on a registered computer, per remote shell.
mod powershell;
use butler_platform::{
    hook_process::HookOutput,
    powershell_text::{decoded, encoded_command},
    windows_args::quote_argument,
};
use powershell::{
    AGENT, DEPLOY, FOLDER, FOLDER_OK, HOME, INSTALLED, PRELUDE, PROBE, REMOVE, UPLOAD,
};
pub(super) use powershell::{QUOTE, RUN, script};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Shell {
    Posix,
    PowerShell,
}

impl Shell {
    /// The shell for a stored computer: its probed OS.
    pub(super) fn of(os: &str) -> Self {
        if os == "windows" {
            Self::PowerShell
        } else {
            Self::Posix
        }
    }
}

/// A command line and the bytes it reads on stdin.
pub(super) struct Remote {
    pub command: String,
    pub stdin: Vec<u8>,
}

/// Whether an `sh` command's result means the computer may be Windows: `sh`
/// is missing (any exit but 0 or 255; cmd's message is localized, so it is
/// never read), or `sh` ran but reports an OS other than Darwin/Linux (MSYS,
/// Cygwin, busybox-w32 ...), the same rule as the key script's exit 90.
/// A wrong guess costs one extra command: PowerShell exits 127 on POSIX.
pub(super) fn try_windows(output: &HookOutput) -> bool {
    match output.exit_code {
        Some(0) => output.stdout.lines().any(|line| {
            line.strip_prefix("os=")
                .is_some_and(|os| !matches!(os, "Darwin" | "Linux"))
        }),
        Some(255) | None => false,
        Some(_) => true,
    }
}

pub(super) fn probe(shell: Shell, folder: &str) -> Remote {
    match shell {
        Shell::Posix => {
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
            Remote {
                command: "sh -s".into(),
                stdin: script.into_bytes(),
            }
        }
        Shell::PowerShell => Remote {
            command: encoded_command(&format!(
                "{PRELUDE}{PROBE}$F={}\n{FOLDER}{FOLDER_OK}",
                decoded(folder)
            )),
            stdin: vec![],
        },
    }
}

pub(super) struct Deploy<'a> {
    pub version: &'a str,
    pub sha: &'a str,
    pub url: &'a str,
    pub folder: &'a str,
}

pub(super) fn deploy(shell: Shell, values: &Deploy<'_>, uploaded: Option<&str>) -> Remote {
    match shell {
        Shell::Posix => {
            let quote = |value: &str| format!("'{}'", value.replace('\'', "'\\''"));
            let command = format!(
                "sh -s -- {} {} {} {}",
                quote(values.version),
                quote(values.sha),
                quote(values.url),
                quote(values.folder)
            );
            let stdin = match uploaded {
                Some(path) => format!("UPLOADED='{path}'\n{SCRIPT}").into_bytes(),
                None => SCRIPT.as_bytes().to_vec(),
            };
            Remote { command, stdin }
        }
        Shell::PowerShell => {
            let url = if values.url.is_empty() {
                decoded("")
            } else {
                decoded(&quote_argument(values.url))
            };
            let uploaded = uploaded.map_or_else(|| "$null".into(), decoded);
            script(&format!(
                "{HOME}{QUOTE}{RUN}$V={}\n$SHA={}\n$URLQ={url}\n$F={}\n$UPLOADED={uploaded}\n{FOLDER}{DEPLOY}",
                decoded(values.version),
                decoded(values.sha),
                decoded(values.folder)
            ))
        }
    }
}

pub(super) fn upload(shell: Shell, short: &str) -> (String, String) {
    match shell {
        Shell::Posix => {
            let path = format!("versions/.upload-{short}");
            let command = format!(
                "umask 077; mkdir -p \"$HOME/.butler-remote/versions\" && cat > \"$HOME/.butler-remote/{path}\""
            );
            (command, path)
        }
        Shell::PowerShell => {
            let path = format!("versions\\.upload-{short}");
            let command = encoded_command(&format!(
                "{PRELUDE}{HOME}{QUOTE}$U={}\n{UPLOAD}",
                decoded(&path)
            ));
            (command, path)
        }
    }
}

pub(super) fn installed(shell: Shell) -> String {
    match shell {
        Shell::Posix => r#"test -x "$HOME/.butler-remote/current/butler-agent""#.into(),
        Shell::PowerShell => encoded_command(&format!("{PRELUDE}{HOME}{INSTALLED}")),
    }
}

pub(super) fn remove(shell: Shell) -> Remote {
    match shell {
        Shell::Posix => Remote {
            command: "sh -s".into(),
            stdin: br#"set -eu
umask 077
R="$HOME/.butler-remote"
if [ -x "$R/current/butler-agent" ]; then
    "$R/current/butler-agent" stop --data "$R/data" --json >/dev/null
fi
rm -rf "$R"
"#
            .to_vec(),
        },
        Shell::PowerShell => Remote {
            command: encoded_command(&format!("{PRELUDE}{HOME}{QUOTE}{RUN}{REMOVE}")),
            stdin: vec![],
        },
    }
}

pub(super) fn request(shell: Shell, method: &str, path: &str) -> String {
    match shell {
        Shell::Posix => {
            let quote = |value: &str| format!("'{}'", value.replace('\'', "'\\''"));
            format!(
                r#""$HOME/.butler-remote/current/butler-agent" --remote-request "$HOME/.butler-remote/data" {} {}"#,
                quote(method),
                quote(path)
            )
        }
        Shell::PowerShell => agent("--remote-request", true, &[method, path]),
    }
}

pub(super) fn stream(shell: Shell, path: &str) -> String {
    match shell {
        Shell::Posix => format!(
            r#""$HOME/.butler-remote/current/butler-agent" --remote-stream "$HOME/.butler-remote/data" '{}'"#,
            path.replace('\'', "'\\''")
        ),
        Shell::PowerShell => agent("--remote-stream", true, &[path]),
    }
}

pub(super) fn loopback(shell: Shell, port: u16) -> String {
    match shell {
        Shell::Posix => {
            format!(r#""$HOME/.butler-remote/current/butler-agent" --remote-loopback {port}"#)
        }
        Shell::PowerShell => agent("--remote-loopback", false, &[&port.to_string()]),
    }
}

pub(super) fn callback(shell: Shell) -> String {
    match shell {
        Shell::Posix => r#""$HOME/.butler-remote/current/butler-agent" --remote-callback "$HOME/.butler-remote/data""#.to_owned(),
        Shell::PowerShell => agent("--remote-callback", true, &[]),
    }
}

fn agent(flag: &str, data: bool, tail: &[&str]) -> String {
    let mut line = format!("$L='{flag}'");
    if data {
        line.push_str("+' '+(Q $D)");
    }
    if !tail.is_empty() {
        let tail: Vec<String> = tail.iter().map(|value| quote_argument(value)).collect();
        line.push_str(&format!("+' '+{}", decoded(&tail.join(" "))));
    }
    encoded_command(&format!("{PRELUDE}{HOME}{QUOTE}{line}\n{AGENT}"))
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
