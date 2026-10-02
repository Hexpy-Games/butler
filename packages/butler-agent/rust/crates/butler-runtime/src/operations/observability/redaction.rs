//! Native diagnostic credentials and home-directory usernames, including exports.
use butler_core::public_text::fixed_regex;
use regex::Regex;
use std::sync::OnceLock;

fn patterns() -> &'static Vec<(Regex, &'static str)> {
    static PATTERNS: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        vec![
            (fixed_regex(r"(?i)(Bearer\s+)[A-Za-z0-9._~+/=-]+"), "$1[redacted]"),
            (fixed_regex(r"(?i)(OPENAI_API_KEY=)[^\s]+"), "$1[redacted]"),
            (fixed_regex(r"bot\d+:[A-Za-z0-9_-]+"), "bot[redacted]"),
            (fixed_regex(r#"(?i)((?:[a-z_]*api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|credential)["']?\s*[:=]\s*["']?)[^\s,"'}]+"#), "$1[redacted]"),
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
