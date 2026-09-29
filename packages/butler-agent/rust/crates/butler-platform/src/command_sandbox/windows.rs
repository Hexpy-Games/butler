//! `cmd.exe` and PowerShell.

use std::collections::HashMap;

use super::Invocation;

pub(super) const POSIX: bool = false;

pub(super) fn login_shell(command: &str, environment: &HashMap<String, String>) -> Invocation {
    let program = environment
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("ComSpec"))
        .map(|(_, value)| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("cmd.exe")
        .to_owned();
    Invocation {
        program,
        arguments: vec!["/d".into(), "/s".into(), "/c".into(), command.to_owned()],
    }
}

pub(super) fn legacy_shell(
    command: &str,
    _pipefail: bool,
    environment: &HashMap<String, Option<String>>,
) -> Invocation {
    let program = environment
        .get("BUTLER_POWERSHELL")
        .and_then(Option::as_deref)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("powershell.exe")
        .to_owned();
    Invocation {
        program,
        arguments: [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            command,
        ]
        .map(str::to_owned)
        .to_vec(),
    }
}
