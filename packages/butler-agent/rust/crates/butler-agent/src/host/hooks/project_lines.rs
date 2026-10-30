//! What the card says about a project hook. Anything that could make a line read
//! differently from what runs is spelled out instead of shown.
use butler_core::hooks::*;
use std::path::Path;

/// A folder name is cut after this many characters on the card.
const MAX_FOLDER_CHARS: usize = 80;
/// A refusal reason is cut after this many characters.
const MAX_REASON_CHARS: usize = 512;

/// Default-ignorable and blank-looking characters: they draw nothing, or nothing
/// a reader can tell apart, so they could hide or disguise part of a command.
fn invisible(character: char) -> bool {
    matches!(character,
        '\u{ad}' | '\u{34f}' | '\u{61c}' | '\u{115f}' | '\u{1160}' | '\u{17b4}' | '\u{17b5}'
        | '\u{180b}'..='\u{180f}' | '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}'
        | '\u{2060}'..='\u{206f}' | '\u{2800}' | '\u{3164}' | '\u{fe00}'..='\u{fe0f}'
        | '\u{feff}' | '\u{ffa0}' | '\u{fff0}'..='\u{fffb}' | '\u{1bca0}'..='\u{1bca3}'
        | '\u{1d173}'..='\u{1d17a}' | '\u{e0000}'..='\u{e0fff}')
}

/// Text exactly as written, one way to read it: unprintable characters and spaces
/// a page would collapse or trim are spelled out.
pub(super) fn visible(text: &str) -> String {
    let mut shown = String::with_capacity(text.len());
    let mut characters = text.chars().peekable();
    let mut previous_space = true;
    while let Some(character) = characters.next() {
        let space = character == ' ';
        match character {
            '\n' => shown.push_str("\\n"),
            '\r' => shown.push_str("\\r"),
            '\t' => shown.push_str("\\t"),
            ' ' if !previous_space && characters.peek().is_some() => shown.push(' '),
            ' ' => shown.push_str("\\u{20}"),
            hidden
                if hidden.is_control()
                    || invisible(hidden)
                    || (hidden.is_whitespace() && !hidden.is_ascii()) =>
            {
                shown.push_str(&format!("\\u{{{:x}}}", u32::from(hidden)));
            }
            other => shown.push(other),
        }
        previous_space = space;
    }
    shown
}

/// A parser's text may quote the file: bounded and spelled out before anyone sees it.
pub(super) fn safe_reason(reason: &str) -> String {
    let cut: String = reason.chars().take(MAX_REASON_CHARS).collect();
    visible(&cut)
}

/// Quotes what a reader could otherwise split differently from the real value.
fn quoted(argument: &str) -> String {
    let plain = !argument.is_empty()
        && argument
            .chars()
            .all(|c| c.is_alphanumeric() || "-_./:=@%+,".contains(c));
    if plain {
        argument.to_owned()
    } else {
        format!("'{}'", argument.replace('\'', "'\\''"))
    }
}

/// The exact action: environment additions first, as a shell would read them. Argv
/// is always quoted, so it never reads like the same text given to a shell.
fn action(hook: &HookDefinition) -> String {
    let mut parts: Vec<String> = hook
        .env
        .iter()
        .map(|(key, value)| format!("{}={}", quoted(key), quoted(value)))
        .collect();
    match (&hook.command, &hook.args) {
        (Some(command), _) => parts.push(command.clone()),
        (None, Some(args)) => parts.extend(
            args.iter()
                .map(|argument| format!("'{}'", argument.replace('\'', "'\\''"))),
        ),
        (None, None) => {}
    }
    visible(&parts.join(" "))
}

/// What affects how a hook runs: its display name does not, and neither does a
/// disabled hook, so a change in those asks nobody.
pub(super) fn runnable(hook: &HookDefinition) -> HookDefinition {
    HookDefinition {
        name: None,
        ..hook.clone()
    }
}

pub(super) fn line(hook: &HookDefinition) -> Result<ProjectHookLine, String> {
    let definition = serde_json::to_string(hook).map_err(|error| error.to_string())?;
    let default_timeout = if hook.asynchronous { 60_000 } else { 30_000 };
    Ok(ProjectHookLine {
        id: hook.id.clone(),
        event: hook.event,
        tools: hook
            .matcher
            .tools
            .iter()
            .map(|tool| visible(tool))
            .collect(),
        command: action(hook),
        timeout_ms: (hook.timeout_ms != default_timeout).then_some(hook.timeout_ms),
        asynchronous: hook.asynchronous,
        fail_closed: hook.fail_closed,
        digest: butler_turn::btcc::digest_identity(&definition),
        change: None,
    })
}

pub(super) fn folder_name(root: &Path) -> String {
    let name: String = root
        .file_name()
        .map(|name| name.to_string_lossy())
        .unwrap_or_default()
        .chars()
        .take(MAX_FOLDER_CHARS)
        .collect();
    visible(&name)
}

fn same_action(left: &ProjectHookLine, right: &ProjectHookLine) -> bool {
    left.event == right.event && left.tools == right.tools && left.command == right.command
}

/// Marks each line against what was allowed last. A hook listed as removed is only
/// a rename when the same action still runs, so it is not listed.
pub(super) fn with_changes(
    mut lines: Vec<ProjectHookLine>,
    last_allowed: &[ProjectHookLine],
) -> Vec<ProjectHookLine> {
    if last_allowed.is_empty() {
        return lines;
    }
    for line in &mut lines {
        line.change = match last_allowed.iter().find(|old| old.id == line.id) {
            None => Some(ProjectHookChange::Added),
            Some(old) if old.digest != line.digest => Some(ProjectHookChange::Changed),
            Some(_) => None,
        };
    }
    let removed: Vec<ProjectHookLine> = last_allowed
        .iter()
        .filter(|old| !lines.iter().any(|line| line.id == old.id))
        .filter(|old| !lines.iter().any(|line| same_action(line, old)))
        .map(|old| ProjectHookLine {
            change: Some(ProjectHookChange::Removed),
            ..old.clone()
        })
        .collect();
    lines.extend(removed);
    lines
}
