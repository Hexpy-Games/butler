//! Pure cmd invocation and verbatim argument construction, testable on any host.

use std::collections::HashMap;

use super::Invocation;

const UTF8_PREFIX: &str = "chcp 65001>nul & ";

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

/// `ComSpec` from `environment`; with several spellings the smallest key wins,
/// so the choice does not depend on the map's iteration order.
pub(super) fn program(environment: &HashMap<String, Option<String>>) -> String {
    environment
        .iter()
        .filter(|(key, _)| key.eq_ignore_ascii_case("ComSpec"))
        .min_by(|(a, _), (b, _)| a.cmp(b))
        .and_then(|(_, value)| value.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("cmd.exe")
        .to_owned()
}

pub(super) fn shell(text: &str, environment: &HashMap<String, Option<String>>) -> Invocation {
    let program = program(environment);
    Invocation {
        program,
        arguments: vec![
            "/d".into(),
            "/s".into(),
            "/c".into(),
            format!("{UTF8_PREFIX}{text}"),
        ],
        ..Default::default()
    }
}

/// The /s quote envelope is command text, never a CRT-escaped argument.
pub(super) fn raw_argument(invocation: &Invocation) -> Option<String> {
    let text = match invocation.arguments.as_slice() {
        [d, s, c, text] if [d, s, c] == ["/d", "/s", "/c"] => text,
        [d, v, s, c, text]
            if d == "/d" && (v == "/v:off" || v == "/v:on") && s == "/s" && c == "/c" =>
        {
            text
        }
        _ => return None,
    };
    let is_cmd = std::path::Path::new(&invocation.program)
        .file_stem()
        .is_some_and(|name| name.eq_ignore_ascii_case("cmd"));
    is_cmd.then(|| format!("\"{text}\""))
}

/// The container bootstrap has already set UTF-8 before this cmd starts.
/// Built-ins cache the startup code page, so ordinary host shells must retain
/// their chcp followed by a fresh cmd. Only the contained path can flatten it.
pub(super) fn inside_utf8_bootstrap(invocation: &mut Invocation) {
    if invocation.shell_program.is_some() || raw_argument(invocation).is_none() {
        return;
    }
    let Some(command) = invocation
        .arguments
        .last()
        .and_then(|s| s.strip_prefix(UTF8_PREFIX))
    else {
        return;
    };
    // Quoted /c envelopes retain cmd's own quote-stripping parser.
    let text = script(command)
        .filter(|s| !s.starts_with('"'))
        .unwrap_or(command)
        .to_owned();
    if let Some(argument) = invocation.arguments.last_mut() {
        *argument = text;
    }
}
