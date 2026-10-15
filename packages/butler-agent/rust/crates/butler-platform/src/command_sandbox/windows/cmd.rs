//! Pure cmd invocation and verbatim argument construction, testable on any host.

use std::collections::HashMap;

use super::Invocation;

// Explicit cmd scripts retain cmd quoting, percent expansion and operators.
// Passing them through PowerShell would reinterpret that syntax first.
pub(super) fn script(command: &str) -> Option<&str> {
    let (program, mut tail) = command.trim().split_once(char::is_whitespace)?;
    if !program.eq_ignore_ascii_case("cmd") && !program.eq_ignore_ascii_case("cmd.exe") {
        return None;
    }
    loop {
        let (argument, rest) = tail.trim_start().split_once(char::is_whitespace)?;
        match argument.to_ascii_lowercase().as_str() {
            "/d" | "/s" => tail = rest,
            "/c" => return Some(rest.trim()),
            _ => return None,
        }
    }
}

pub(super) fn shell(text: &str, environment: &HashMap<String, Option<String>>) -> Invocation {
    let program = environment
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("ComSpec"))
        .and_then(|(_, value)| value.as_deref())
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
            format!("chcp 65001>nul & {text}"),
        ],
        ..Default::default()
    }
}

/// The /s quote envelope is command text, never a CRT-escaped argument.
pub(super) fn raw_argument(invocation: &Invocation) -> Option<String> {
    let text = match invocation.arguments.as_slice() {
        [d, s, c, text] if [d, s, c] == ["/d", "/s", "/c"] => text,
        [d, v, s, c, text] if [d, v, s, c] == ["/d", "/v:off", "/s", "/c"] => text,
        _ => return None,
    };
    let is_cmd = std::path::Path::new(&invocation.program)
        .file_stem()
        .is_some_and(|name| name.eq_ignore_ascii_case("cmd"));
    is_cmd.then(|| format!("\"{text}\""))
}
