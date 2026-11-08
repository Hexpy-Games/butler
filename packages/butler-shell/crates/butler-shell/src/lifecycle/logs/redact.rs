//! `log/redaction.mjs`: a port of butler-log `structured_logging/{patterns,redaction}`. No raw
//! header, token, cookie, pairing code or home-folder name survives into the app log.
use std::collections::BTreeSet;
use std::sync::OnceLock;

use regex::{Captures, Regex};
use serde_json::{Map, Value};
use url::Url;

const MASK: &str = "[REDACTED]";
const KEYS: &str = r"api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|credential|authorization|session[_-]?key";

/// Pattern and replacement, in the order `redaction.mjs` applies them.
fn patterns() -> &'static [(Regex, &'static str)] {
    static PATTERNS: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        let json_key = format!(r#"(?i)("(?:{KEYS})"\s*:\s*)"(?:\\.|[^"\\])*""#);
        let assigned = format!(r#"(?i)((?:{KEYS})["']?\s*[:=]\s*["']?)[^\s,"'}}]+"#);
        let source: Vec<(String, &'static str)> = vec![
            (json_key, r#"${1}"[REDACTED]""#),
            (r"(?i)(\b[A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|ID_TOKEN|PASSWORD|SECRET)[A-Z0-9_]*\s*[:=]\s*)\S+".into(), "${1}[REDACTED]"),
            (r"(?i)(Bearer\s+)[A-Za-z0-9._~+/=-]+".into(), "${1}[REDACTED]"),
            (r"(?i)(OPENAI_API_KEY=)\S+".into(), "${1}[REDACTED]"),
            (r"bot\d+:[A-Za-z0-9_-]+".into(), "bot[REDACTED]"),
            (assigned, "${1}[REDACTED]"),
            (r"\bsk-[A-Za-z0-9_-]+".into(), "[REDACTED]"),
            (r#"(?i)(["'](?:set-cookie|cookie)["']\s*[:=]\s*")(?:\\.|[^"\\\r\n])*"#.into(), "${1}[REDACTED]"),
            (r#"(?i)(["'](?:set-cookie|cookie)["']\s*[:=]\s*')(?:\\.|[^'\\\r\n])*"#.into(), "${1}[REDACTED]"),
            (r#"(?i)((?:^|[^"'A-Za-z0-9_-])(?:set-cookie|cookie)\s*[:=]\s*)[^\r\n]+"#.into(), "${1}[REDACTED]"),
            (r"\bv2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+".into(), "[REDACTED]"),
            (r#"(?i)((?:pairing|connection)[ _-]?code["']?\s*[:=]\s*["']?)(?:\d{4}[ \t]+\d{4}|[A-Z0-9]{4}(?:[ -][A-Z0-9]{4}){3}|[^\s,"'}]+)"#.into(), "${1}[REDACTED]"),
            (r#"(?i)([?&]code=)[^&\s"'<>]+"#.into(), "${1}[REDACTED]"),
            (r#"(?i)(\bcode["']?\s*[:=]\s*["']?)(?:\d{8}|\d{4}[ \t]+\d{4}|[A-Z0-9]{4}(?:[ -][A-Z0-9]{4}){3})\b"#.into(), "${1}[REDACTED]"),
            (r#"(/(?:home|Users)/)[^/\\\r\n"'<>]+(/)"#.into(), "${1}[redacted-user]${2}"),
            (r#"(/(?:home|Users)/)[^/\\\r\n"'<>]+(["'])"#.into(), "${1}[redacted-user]${2}"),
            (r#"(/(?:home|Users)/)[^/\\\s"'<>]+"#.into(), "${1}[redacted-user]"),
            (r#"(?i)((?:[A-Z]:)?\\+(?:Users|home)\\+)[^/\\\r\n"'<>]+(\\+)"#.into(), "${1}[redacted-user]${2}"),
            (r#"(?i)((?:[A-Z]:)?\\+(?:Users|home)\\+)[^/\\\r\n"'<>]+(["'])"#.into(), "${1}[redacted-user]${2}"),
            (r#"(?i)((?:[A-Z]:)?\\+(?:Users|home)\\+)[^/\\\s"'<>]+"#.into(), "${1}[redacted-user]"),
        ];
        source
            .into_iter()
            .filter_map(|(pattern, replacement)| Regex::new(&pattern).ok().map(|re| (re, replacement)))
            .collect()
    })
}

fn matcher(cell: &'static OnceLock<Option<Regex>>, pattern: &str) -> Option<&'static Regex> {
    cell.get_or_init(|| Regex::new(pattern).ok()).as_ref()
}

/// `SECRET`: a field name whose value is never kept.
fn secret_key(key: &str) -> bool {
    static CELL: OnceLock<Option<Regex>> = OnceLock::new();
    let pattern = r"(?i)api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|password|secret|authorization|credential|session[_-]?key|cookie|pairing[_-]?code|connection[_-]?code|^token$";
    matcher(&CELL, pattern).is_some_and(|re| re.is_match(key))
}

/// `QUERY`: a URL parameter whose value is never kept.
fn secret_param(key: &str) -> bool {
    static CELL: OnceLock<Option<Regex>> = OnceLock::new();
    let pattern = r"(?i)^(key|token|code|sig|signature|x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential)$";
    matcher(&CELL, pattern).is_some_and(|re| re.is_match(key))
}

/// `createRedactor`: the secrets this process knows, plus the patterns above.
#[derive(Default)]
pub(super) struct Redactor {
    permanent: BTreeSet<String>,
    ephemeral: Vec<String>,
}

impl Redactor {
    /// `remember`: secrets shorter than 16 characters are not worth matching; at most 256
    /// ephemeral ones are kept, the oldest dropped first.
    pub(super) fn remember(&mut self, value: &str, persistent: bool) {
        let secret = value.strip_prefix("Bearer ").unwrap_or(value);
        if secret.chars().count() < 16 {
            return;
        }
        if persistent {
            self.permanent.insert(secret.to_owned());
        } else if !self.ephemeral.iter().any(|known| known == secret) {
            self.ephemeral.push(secret.to_owned());
            if self.ephemeral.len() > 256 {
                self.ephemeral.remove(0);
            }
        }
    }

    fn text(&self, input: &str) -> String {
        let mut secrets: Vec<&String> = self.permanent.iter().chain(&self.ephemeral).collect();
        secrets.sort_by_key(|secret| std::cmp::Reverse(secret.len()));
        let mut result = input.to_owned();
        for secret in secrets {
            result = result.replace(secret.as_str(), MASK);
        }
        for (pattern, replacement) in patterns() {
            result = pattern.replace_all(&result, *replacement).into_owned();
        }
        result
    }

    /// `url`: credentials, secret parameters and credential-like path parts are masked.
    fn url(&self, input: &str) -> String {
        let Ok(mut value) = Url::parse(input) else {
            return self.text(input);
        };
        if !value.username().is_empty() {
            let _ = value.set_username(MASK);
        }
        if value.password().is_some() {
            let _ = value.set_password(Some(MASK));
        }
        let pairs: Vec<(String, String)> = value.query_pairs().into_owned().collect();
        if pairs
            .iter()
            .any(|(key, _)| secret_key(key) || secret_param(key))
        {
            let masked = pairs.into_iter().map(|(key, item)| {
                let hide = secret_key(&key) || secret_param(&key);
                (key, if hide { MASK.to_owned() } else { item })
            });
            value.query_pairs_mut().clear().extend_pairs(masked);
        }
        let path = value
            .path()
            .split('/')
            .map(|part| {
                let credential = part.len() >= 16
                    && part.chars().any(|c| c.is_ascii_alphabetic())
                    && part.chars().any(|c| c.is_ascii_digit());
                if credential { MASK } else { part }
            })
            .collect::<Vec<_>>()
            .join("/");
        value.set_path(&path);
        self.text(value.as_str())
    }

    fn string(&self, input: &str) -> String {
        static CELL: OnceLock<Option<Regex>> = OnceLock::new();
        let text = self.text(input);
        match matcher(&CELL, r#"https?://[^\s"'<>]+"#) {
            Some(re) => re
                .replace_all(&text, |found: &Captures<'_>| self.url(&found[0]))
                .into_owned(),
            None => text,
        }
    }

    /// `redact`: strings, keys and nested values; a secret-named field becomes the mask.
    pub(super) fn redact(&self, value: &Value) -> Value {
        match value {
            Value::String(text) => Value::String(self.string(text)),
            Value::Array(items) => {
                Value::Array(items.iter().map(|item| self.redact(item)).collect())
            }
            Value::Object(map) => Value::Object(
                map.iter()
                    .map(|(key, item)| {
                        let keep = key == "secrets_redacted" && item.is_boolean();
                        let hidden = secret_key(key) && !keep;
                        let item = if hidden {
                            Value::String(MASK.to_owned())
                        } else {
                            self.redact(item)
                        };
                        (self.text(key), item)
                    })
                    .collect::<Map<_, _>>(),
            ),
            other => other.clone(),
        }
    }
}
