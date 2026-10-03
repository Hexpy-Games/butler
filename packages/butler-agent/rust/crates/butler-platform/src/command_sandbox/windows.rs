//! `cmd.exe` and PowerShell.

use base64::{Engine, engine::general_purpose::STANDARD};
use std::collections::HashMap;

use super::Invocation;

pub(super) const ESCAPE: char = '`';

pub(super) const POSIX: bool = false;

/// `cmd.exe /d /s /c <command>` takes the command verbatim: with `/s`, `cmd`
/// strips the first and the last quote of the line and runs what is between.
pub(super) fn add_arguments(command: &mut std::process::Command, invocation: &Invocation) {
    use std::os::windows::process::CommandExt;
    match invocation.arguments.as_slice() {
        [d, s, c, text] if is_cmd(&invocation.program) && [d, s, c] == ["/d", "/s", "/c"] => {
            command.args([d, s, c]).raw_arg(format!("\"{text}\""));
        }
        arguments => {
            command.args(arguments);
        }
    }
}

fn is_cmd(program: &str) -> bool {
    std::path::Path::new(program)
        .file_stem()
        .is_some_and(|name| name.eq_ignore_ascii_case("cmd"))
}

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
        arguments: vec![
            "/d".into(),
            "/s".into(),
            "/c".into(),
            format!("chcp 65001>nul & {command}"),
        ],
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
    let command = explicit_script(command).unwrap_or(command);
    // EncodedCommand preserves nested quotes and multi-line scripts without
    // cmd/CRT/PowerShell argument reparsing. Set both console and pipeline
    // encodings; native reg/cmd output follows the console code page.
    let script = format!(
        "[Console]::InputEncoding=[Text.UTF8Encoding]::new(); [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); $OutputEncoding=[Console]::OutputEncoding; {command}"
    );
    let encoded = STANDARD.encode(
        script
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    );
    Invocation {
        program,
        arguments: [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-OutputFormat",
            "Text",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            &encoded,
        ]
        .map(str::to_owned)
        .to_vec(),
    }
}

// The tool accepts the common cmd-style `powershell.exe -Command "script"`.
// Running that through another PowerShell expands $variables in the outer
// double-quoted argument before the requested script ever sees them. Standard
// startup switches are already enforced by our invocation; run the script once.
fn explicit_script(command: &str) -> Option<&str> {
    let (program, tail) = command.trim().split_once(char::is_whitespace)?;
    if !program.eq_ignore_ascii_case("powershell.exe")
        && !program.eq_ignore_ascii_case("powershell")
    {
        return None;
    }
    let offset = tail.to_ascii_lowercase().find("-command ")?;
    let prefix = tail.get(..offset)?;
    let mut arguments = prefix.split_whitespace();
    while let Some(argument) = arguments.next() {
        match argument.to_ascii_lowercase().as_str() {
            "-nologo" | "-noprofile" | "-noninteractive" => {}
            "-executionpolicy"
                if arguments
                    .next()
                    .is_some_and(|value| value.eq_ignore_ascii_case("Bypass")) => {}
            _ => return None,
        }
    }
    tail.get(offset + "-command ".len()..)?
        .trim()
        .strip_prefix('"')?
        .strip_suffix('"')
}

/// Both reg.exe key paths and PowerShell registry-provider paths.
pub(super) fn normalize_path_token(path: &str) -> String {
    path.replace('\\', "/")
}

pub(super) fn is_registry_path(path: &str) -> bool {
    let root = path.split(['/', '\\', ':']).next().unwrap_or_default();
    [
        "HKCU",
        "HKLM",
        "HKCR",
        "HKU",
        "HKCC",
        "HKEY_CURRENT_USER",
        "HKEY_LOCAL_MACHINE",
        "HKEY_CLASSES_ROOT",
        "HKEY_USERS",
        "HKEY_CURRENT_CONFIG",
    ]
    .iter()
    .any(|key| root.eq_ignore_ascii_case(key))
}
