//! Emulate password authentication while keeping the SSH transport real.
use super::{HarnessError, harness_error};
use std::{env, fs, path::Path, process::Command};

pub fn write(bin: &Path, admin_key: &Path, password: &str) -> Result<String, HarnessError> {
    let real_ssh = Command::new("sh").args(["-c", "command -v ssh"]).output()?;
    if !real_ssh.status.success() {
        return Err(harness_error("OpenSSH client is required"));
    }
    let real_ssh = String::from_utf8_lossy(&real_ssh.stdout);
    let path = env::var_os("PATH").ok_or_else(|| harness_error("PATH is unset"))?;
    let path = env::join_paths(std::iter::once(bin.to_owned()).chain(env::split_paths(&path)))
        .map_err(|error| harness_error(error.to_string()))?;
    fs::create_dir_all(bin)?;
    fs::write(bin.join("password"), password)?;
    fs::write(bin.join("password-count"), "0\n")?;
    let script = bin.join("ssh");
    let quote = |value: &str| format!("'{}'", value.replace('\'', "'\\''"));
    fs::write(
        &script,
        format!(
            r#"#!/bin/sh
set -eu
real_ssh={real_ssh}
admin_key={admin_key}
bin={bin}
for arg do
    case "$arg" in
        PreferredAuthentications=none)
            stderr=$(mktemp "$bin/stderr.XXXXXX")
            trap 'rm -f "$stderr"' EXIT
            status=0
            "$real_ssh" "$@" 2>"$stderr" || status=$?
            sed 's/Permission denied (publickey)\./Permission denied (publickey,password)./' "$stderr" >&2
            exit "$status"
            ;;
        PubkeyAuthentication=no)
            count=$(cat "$bin/password-count")
            printf '%s\n' "$((count + 1))" > "$bin/password-count"
            if ! answer=$("$SSH_ASKPASS" "password: ") || [ "$answer" != "$(cat "$bin/password")" ]; then
                printf '%s\n' 'Permission denied (password).' >&2
                exit 255
            fi
            exec "$real_ssh" -o BatchMode=yes -o PubkeyAuthentication=yes \
                -o PreferredAuthentications=publickey -o IdentitiesOnly=yes -i "$admin_key" "$@"
            ;;
    esac
done
exec "$real_ssh" "$@"
"#,
            real_ssh = quote(real_ssh.trim()),
            admin_key = quote(&admin_key.to_string_lossy()),
            bin = quote(&bin.to_string_lossy()),
        ),
    )?;
    butler_platform::launcher::mark_executable(&script).unwrap_or(Ok(()))?;
    Ok(path.to_string_lossy().into_owned())
}
