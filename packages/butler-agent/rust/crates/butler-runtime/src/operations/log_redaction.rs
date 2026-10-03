//! Native diagnostic credentials and home-directory usernames, including exports.
use butler_core::public_text::fixed_regex;
use regex::Regex;
use serde_json::{Map, Value};
use std::sync::OnceLock;

fn patterns() -> &'static Vec<(Regex, &'static str)> {
    static PATTERNS: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        vec![
            (fixed_regex(r#"(?i)("(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|authorization|credential|session[_-]?key)"\s*:\s*)"(?:\\.|[^"\\])*""#), "$1\"[redacted]\""),
            (fixed_regex(r"(?i)(\b[A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|ID_TOKEN|PASSWORD|SECRET)[A-Z0-9_]*\s*[:=]\s*)\S+"), "$1[redacted]"),
            (fixed_regex(r"(?i)(Bearer\s+)[A-Za-z0-9._~+/=-]+"), "$1[redacted]"),
            (fixed_regex(r"(?i)(OPENAI_API_KEY=)[^\s]+"), "$1[redacted]"),
            (fixed_regex(r"bot\d+:[A-Za-z0-9_-]+"), "bot[redacted]"),
            (fixed_regex(r#"(?i)((?:[a-z_]*api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|credential|authorization|session[_-]?key)["']?\s*[:=]\s*["']?)[^\s,"'}]+"#), "$1[redacted]"),
            (fixed_regex(r"\bsk-[A-Za-z0-9_-]+"), "[redacted]"),
            // A Cookie/Set-Cookie header is a secret as a whole, even for
            // cookies whose names this version of Butler does not recognize.
            (fixed_regex(r#"(?i)(["'](?:set-cookie|cookie)["']\s*[:=]\s*")(?:\\.|[^"\\\r\n])*"#), "$1[redacted]"),
            (fixed_regex(r#"(?i)(["'](?:set-cookie|cookie)["']\s*[:=]\s*')(?:\\.|[^'\\\r\n])*"#), "$1[redacted]"),
            (fixed_regex(r#"(?i)((?:^|[^"'A-Za-z0-9_-])(?:set-cookie|cookie)\s*[:=]\s*)[^\r\n]+"#), "$1[redacted]"),
            (fixed_regex(r"\bv2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"), "[redacted]"),
            (fixed_regex(r#"(?i)((?:pairing|connection)[ _-]?code["']?\s*[:=]\s*["']?)(?:\d{4}[ \t]+\d{4}|[A-Z0-9]{4}(?:[ -][A-Z0-9]{4}){3}|[^\s,"'}]+)"#), "$1[redacted]"),
            (fixed_regex(r#"(?i)([?&]code=)[^&\s"'<>]+"#), "$1[redacted]"),
            // Keep operational error codes and numeric counts visible.
            (fixed_regex(r#"(?i)(\bcode["']?\s*[:=]\s*["']?)(?:\d{8}|\d{4}[ \t]+\d{4}|[A-Z0-9]{4}(?:[ -][A-Z0-9]{4}){3})\b"#), "$1[redacted]"),
            (fixed_regex(r#"(/(?:home|Users)/)[^/\\\r\n"'<>]+(/)"#), "$1[redacted-user]$2"),
            (fixed_regex(r#"(/(?:home|Users)/)[^/\\\r\n"'<>]+(["'])"#), "$1[redacted-user]$2"),
            (fixed_regex(r#"(/(?:home|Users)/)[^/\\\s"'<>]+"#), "$1[redacted-user]"),
            // Accept doubled backslashes in JSON as well as native paths.
            (fixed_regex(r#"(?i)((?:[A-Z]:)?\\+(?:Users|home)\\+)[^/\\\r\n"'<>]+(\\+)"#), "$1[redacted-user]$2"),
            (fixed_regex(r#"(?i)((?:[A-Z]:)?\\+(?:Users|home)\\+)[^/\\\r\n"'<>]+(["'])"#), "$1[redacted-user]$2"),
            (fixed_regex(r#"(?i)((?:[A-Z]:)?\\+(?:Users|home)\\+)[^/\\\s"'<>]+"#), "$1[redacted-user]"),
        ]
    })
}

pub fn redact_log_line(line: &str) -> String {
    patterns()
        .iter()
        .fold(line.to_owned(), |line, (pattern, replacement)| {
            pattern.replace_all(&line, *replacement).into_owned()
        })
}

fn secret_key() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    VALUE.get_or_init(|| fixed_regex(r"(?i)(api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|password|secret|authorization|credential|session[_-]?key|cookie|pairing[_-]?code|connection[_-]?code|^token$)"))
}

pub(super) fn redact_json(value: &Value) -> Value {
    match value {
        Value::String(value) => {
            Value::String(redact_log_line(value).replace("[redacted]", "[REDACTED]"))
        }
        Value::Array(items) => Value::Array(items.iter().map(redact_json).collect()),
        Value::Object(object) => {
            let mut output = Map::new();
            for (key, item) in object {
                output.insert(
                    key.clone(),
                    if key == "secrets_redacted" && item.is_boolean() {
                        item.clone()
                    } else if secret_key().is_match(key) {
                        Value::String("[REDACTED]".into())
                    } else {
                        redact_json(item)
                    },
                );
            }
            Value::Object(output)
        }
        other => other.clone(),
    }
}
