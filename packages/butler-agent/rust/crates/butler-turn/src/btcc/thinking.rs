//! Display-only reasoning summary policy shared by the gateway and turn runtime.
use std::sync::atomic::{AtomicBool, Ordering};
static CAPTURE: AtomicBool = AtomicBool::new(false);
/// Update the process-local App preference after settings are loaded or committed.
pub fn set_capture(enabled: bool) {
    CAPTURE.store(enabled, Ordering::Release);
}
/// Non-App destinations never capture summaries.
pub(super) fn capture() -> bool {
    CAPTURE.load(Ordering::Acquire)
}

fn heading(line: &str) -> Option<&str> {
    let line = line.trim();
    if let Some(rest) = line.strip_prefix("**") {
        return rest.strip_suffix("**").filter(|rest| !rest.is_empty());
    }
    let rest = line.trim_start_matches('#');
    (rest.len() != line.len() && rest.starts_with(char::is_whitespace)).then_some(rest)
}
pub(super) fn derive(tail: &str) -> Option<String> {
    let complete = tail.rsplit_once('\n').map_or("", |(complete, _)| complete);
    let line = tail
        .lines()
        .rev()
        .find_map(heading)
        .or_else(|| complete.lines().rev().find(|line| !line.trim().is_empty()))?;
    let plain = strip_markdown(line);
    let collapsed = plain.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut units = 0;
    let capped: String = collapsed
        .chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= 120
        })
        .collect();
    (!capped.is_empty()).then_some(capped)
}
fn strip_markdown(line: &str) -> String {
    let mut plain = String::new();
    let mut chars = line
        .trim()
        .trim_start_matches(['#', '>', '-', '+'])
        .chars()
        .peekable();
    while let Some(c) = chars.next() {
        if matches!(c, '*' | '_' | '`' | '~' | '[' | ']') {
            continue;
        }
        if c == '(' && plain.ends_with(|c: char| !c.is_whitespace()) {
            let rest: String = chars.clone().collect();
            if rest.starts_with("http://") || rest.starts_with("https://") {
                for c in chars.by_ref() {
                    if c == ')' {
                        break;
                    }
                }
                continue;
            }
        }
        if c == '\\' {
            if let Some(next) = chars.next() {
                plain.push(next);
            }
        } else {
            plain.push(c);
        }
    }
    plain
}
