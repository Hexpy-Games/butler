//! `butler-progress-projection/src/public-text.ts`: text that is safe to show as progress.
use serde_json::Value;

const SECRET_KEYS: [&str; 8] = [
    "database_url",
    "api_key",
    "api-key",
    "password",
    "apikey",
    "secret",
    "token",
    "db_url",
];
const AUTH_KEYS: [&str; 2] = ["authorization", "auth"];
const THINK_TAGS: [&str; 3] = ["thinking", "reasoning", "think"];
const CHANNEL_TAGS: [&str; 6] = [
    "assistant",
    "analysis",
    "channel",
    "message",
    "start",
    "final",
];
const PHRASES: [&str; 13] = [
    "hidden reasoning",
    "chain of thought",
    "chain-of-thought",
    "scratchpad",
    "internal plan",
    "let me think",
    "let's think",
    "i need to think",
    "we need to think",
    "step by step reasoning",
    "step-by-step reasoning",
    "step by-step reasoning",
    "step-by step reasoning",
];
const PRIVATE_WORDS: [&str; 10] = [
    "tool_call",
    "tool_result",
    "argumentsJson",
    "raw transcript",
    "sessionId",
    "eventId",
    "FileNotFoundException",
    "root_path",
    "butler-workers",
    "ENOENT",
];
const PATH_ROOTS: [&str; 9] = [
    "Users",
    "private",
    "tmp",
    "var/folders",
    "home",
    "Volumes",
    "opt",
    "usr",
    "etc",
];

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn boundary_before(chars: &[char], at: usize) -> bool {
    at == 0 || !is_word(chars[at - 1])
}

fn boundary_at(chars: &[char], at: usize) -> bool {
    at >= chars.len() || !is_word(chars[at])
}

/// The end of `needle` when `chars` holds it at `at`, ignoring ASCII case.
fn matches_at(chars: &[char], at: usize, needle: &str) -> Option<usize> {
    let mut end = at;
    for expected in needle.chars() {
        let c = *chars.get(end)?;
        if !c.eq_ignore_ascii_case(&expected) {
            return None;
        }
        end += 1;
    }
    Some(end)
}

fn skip_space(chars: &[char], mut at: usize) -> usize {
    while chars.get(at).is_some_and(|c| c.is_whitespace()) {
        at += 1;
    }
    at
}

/// The end of the `\S+` run at `at`, if it has one.
fn non_space_run(chars: &[char], at: usize) -> Option<usize> {
    let mut end = at;
    while chars.get(end).is_some_and(|c| !c.is_whitespace()) {
        end += 1;
    }
    (end > at).then_some(end)
}

/// A `secretAssignmentPattern` match starting at `at`: its end.
fn secret_assignment_at(chars: &[char], at: usize) -> Option<usize> {
    if !boundary_before(chars, at) {
        return None;
    }
    let assignment = |keys: &[&str], bearer: bool| {
        keys.iter().find_map(|key| {
            let mut next = skip_space(chars, matches_at(chars, at, key)?);
            if !matches!(chars.get(next), Some(':' | '=')) {
                return None;
            }
            next = skip_space(chars, next + 1);
            if bearer
                && let Some(after) = matches_at(chars, next, "bearer")
                && chars.get(after).is_some_and(|c| c.is_whitespace())
                && let Some(end) = non_space_run(chars, skip_space(chars, after))
            {
                return Some(end);
            }
            non_space_run(chars, next)
        })
    };
    assignment(&SECRET_KEYS, false).or_else(|| assignment(&AUTH_KEYS, true))
}

fn redact_assignments(chars: &[char]) -> Vec<char> {
    let mut out = Vec::with_capacity(chars.len());
    let mut at = 0;
    while at < chars.len() {
        if let Some(end) = secret_assignment_at(chars, at) {
            out.extend("[redacted]".chars());
            at = end;
        } else {
            out.push(chars[at]);
            at += 1;
        }
    }
    out
}

fn redact_bearer(chars: &[char]) -> Vec<char> {
    let is_token = |c: char| is_word(c) || ".~+/=-".contains(c);
    let mut out = Vec::with_capacity(chars.len());
    let mut at = 0;
    while at < chars.len() {
        if boundary_before(chars, at)
            && let Some(after) = matches_at(chars, at, "bearer")
            && chars.get(after).is_some_and(|c| c.is_whitespace())
        {
            let start = skip_space(chars, after);
            let mut end = start;
            while chars.get(end).is_some_and(|c| is_token(*c)) {
                end += 1;
            }
            if end > start {
                out.extend("Bearer [redacted]".chars());
                at = end;
                continue;
            }
        }
        out.push(chars[at]);
        at += 1;
    }
    out
}

fn collapse_space(chars: &[char]) -> String {
    let text: String = chars.iter().collect();
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn has_think_tag(chars: &[char]) -> bool {
    (0..chars.len()).any(|at| {
        if chars[at] != '<' {
            return false;
        }
        let mut next = skip_space(chars, at + 1);
        if chars.get(next) == Some(&'/') {
            next = skip_space(chars, next + 1);
        }
        let named = THINK_TAGS
            .iter()
            .find_map(|tag| matches_at(chars, next, tag).filter(|end| boundary_at(chars, *end)));
        named.is_some_and(|end| chars[end..].contains(&'>'))
    })
}

fn has_channel_tag(chars: &[char]) -> bool {
    (0..chars.len()).any(|at| {
        if chars[at] != '<' {
            return false;
        }
        let next = if chars.get(at + 1) == Some(&'|') {
            at + 2
        } else {
            at + 1
        };
        let named = CHANNEL_TAGS
            .iter()
            .find_map(|tag| matches_at(chars, next, tag));
        named.is_some_and(|end| chars[end..].contains(&'>'))
    })
}

fn has_phrase(chars: &[char]) -> bool {
    (0..chars.len()).any(|at| {
        boundary_before(chars, at)
            && PHRASES.iter().any(|phrase| {
                matches_at(chars, at, phrase).is_some_and(|end| boundary_at(chars, end))
            })
    })
}

fn has_private_word(chars: &[char]) -> bool {
    let text: String = chars.iter().collect();
    PRIVATE_WORDS.iter().any(|word| {
        text.match_indices(word).any(|(at, _)| {
            let start = text[..at].chars().count();
            let end = start + word.chars().count();
            boundary_before(chars, start) && boundary_at(chars, end)
        })
    })
}

fn path_lead(chars: &[char], at: usize) -> bool {
    at == 0
        || chars[at - 1].is_whitespace()
        || matches!(chars[at - 1], '"' | '\'' | '`' | ':' | '=')
}

fn has_path(chars: &[char]) -> bool {
    (0..chars.len()).any(|at| {
        if !path_lead(chars, at) {
            return false;
        }
        let unix = chars.get(at) == Some(&'/')
            && PATH_ROOTS.iter().any(|root| {
                let end = at + 1 + root.chars().count();
                chars[at + 1..]
                    .iter()
                    .take(root.chars().count())
                    .copied()
                    .eq(root.chars())
                    && boundary_at(chars, end)
            });
        let drive = chars.get(at).is_some_and(char::is_ascii_alphabetic)
            && chars.get(at + 1) == Some(&':')
            && chars.get(at + 2) == Some(&'\\');
        let unc = chars.get(at) == Some(&'\\')
            && chars.get(at + 1) == Some(&'\\')
            && unc_share(chars, at + 2);
        unix || drive || unc
    })
}

/// `[^\s\\]+\\[^\s\\]+` at `at`.
fn unc_share(chars: &[char], at: usize) -> bool {
    let part = |from: usize| {
        let mut end = from;
        while chars
            .get(end)
            .is_some_and(|c| !c.is_whitespace() && *c != '\\')
        {
            end += 1;
        }
        end
    };
    let host = part(at);
    host > at && chars.get(host) == Some(&'\\') && part(host + 1) > host + 1
}

fn looks_like_json_dump(text: &str) -> bool {
    text.trim_start().starts_with(['{', '['])
        && ["eventId", "sessionId", "payload", "arguments", "tool_call"]
            .iter()
            .any(|key| text.contains(&format!("\"{key}\"")))
}

fn looks_private_text(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    has_think_tag(&chars)
        || has_channel_tag(&chars)
        || has_phrase(&chars)
        || has_private_word(&chars)
        || has_path(&chars)
        || looks_like_json_dump(text)
}

fn base64_value(c: char) -> Option<u8> {
    match c {
        'A'..='Z' => Some(c as u8 - b'A'),
        'a'..='z' => Some(c as u8 - b'a' + 26),
        '0'..='9' => Some(c as u8 - b'0' + 52),
        '+' | '-' => Some(62),
        '/' | '_' => Some(63),
        _ => None,
    }
}

/// `decodeBase64Candidate`: the UTF-8 text a long base64-looking value holds.
fn decode_base64(value: &str) -> Option<String> {
    let compact: String = value.split_whitespace().collect();
    let length = compact.chars().count();
    if !(24..=2048).contains(&length) {
        return None;
    }
    let body = compact.trim_end_matches('=');
    if compact.len() - body.len() > 2 || body.contains('=') {
        return None;
    }
    let mut bytes = Vec::new();
    let (mut bits, mut count) = (0u32, 0u32);
    for c in body.chars() {
        bits = (bits << 6) | u32::from(base64_value(c)?);
        count += 6;
        if count >= 8 {
            count -= 8;
            bytes.push(u8::try_from((bits >> count) & 0xff).ok()?);
        }
    }
    if body.len() % 4 == 1 {
        return None;
    }
    String::from_utf8(bytes)
        .ok()
        .filter(|text| !text.is_empty())
}

fn looks_private_or_internal(text: &str) -> bool {
    looks_private_text(text)
        || decode_base64(text).is_some_and(|decoded| looks_private_text(&decoded))
}

/// The text a JSON value stands for (`typeof` string, number or boolean), else empty.
fn raw_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        Value::Bool(flag) => flag.to_string(),
        _ => String::new(),
    }
}

/// `sanitizePublicText`.
pub(crate) fn sanitize_public_text(value: Option<&Value>, fallback: &str) -> String {
    let raw = value.map(raw_text).unwrap_or_default();
    let stripped: Vec<char> = raw
        .chars()
        .map(|c| {
            if (c as u32) < 32 || c as u32 == 127 {
                ' '
            } else {
                c
            }
        })
        .collect();
    let redacted = redact_bearer(&redact_assignments(&stripped));
    let normalized = collapse_space(&redacted);
    if normalized.is_empty() || looks_private_or_internal(&normalized) {
        return fallback.to_string();
    }
    normalized
}
