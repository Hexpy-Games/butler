//! Pure cmd invocation and verbatim argument construction, testable on any host.

use std::collections::HashMap;

use super::Invocation;

// Recognize cmd startup switches without interpreting the script itself.
fn parse(command: &str) -> Option<(Vec<&str>, &str)> {
    let (program, mut tail) = command.trim().split_once(char::is_whitespace)?;
    if !program.eq_ignore_ascii_case("cmd") && !program.eq_ignore_ascii_case("cmd.exe") {
        return None;
    }
    let mut switches = vec!["/d", "/s"];
    loop {
        let (argument, rest) = tail.trim_start().split_once(char::is_whitespace)?;
        match argument.to_ascii_lowercase().as_str() {
            "/d" | "/s" => {}
            "/a" | "/u" | "/q" | "/e:on" | "/e:off" | "/f:on" | "/f:off" | "/v:on" | "/v:off" => {
                switches.push(argument);
            }
            "/c" => return Some((switches, rest.trim())),
            _ => return None,
        }
        tail = rest;
    }
}

pub(super) fn script(command: &str) -> Option<&str> {
    parse(command).map(|(_, script)| script)
}

pub(super) fn shell(
    text: &str,
    environment: &HashMap<String, Option<String>>,
) -> Option<Invocation> {
    let program = environment
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("ComSpec"))
        .and_then(|(_, value)| value.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("cmd.exe")
        .to_owned();
    let (switches, script) = parse(text)?;
    // /s removes one outer quote pair. Remove the user's envelope before
    // adding ours, leaving internal quotes, carets and expansion untouched.
    let script = script
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .unwrap_or(script);
    let mut arguments: Vec<_> = switches.into_iter().map(str::to_owned).collect();
    arguments.extend(["/c".into(), format!("chcp 65001>nul & {script}")]);
    Some(Invocation {
        program,
        arguments,
        restore_cwd: false,
        raw_cmd_script: true,
    })
}

/// The /s quote envelope is command text, never a CRT-escaped argument.
pub(super) fn raw_argument(invocation: &Invocation) -> Option<String> {
    if !invocation.raw_cmd_script {
        return None;
    }
    invocation
        .arguments
        .last()
        .map(|script| format!("\"{script}\""))
}
