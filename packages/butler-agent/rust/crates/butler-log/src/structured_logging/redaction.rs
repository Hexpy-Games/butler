use super::patterns;
use parking_lot::RwLock;
use serde_json::Value;
use std::{fmt, sync::OnceLock};

pub struct Secret<T>(pub T);
impl<T> fmt::Debug for Secret<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[REDACTED]")
    }
}
impl<T> fmt::Display for Secret<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[REDACTED]")
    }
}
fn secrets() -> &'static RwLock<Vec<String>> {
    static SECRETS: OnceLock<RwLock<Vec<String>>> = OnceLock::new();
    SECRETS.get_or_init(RwLock::default)
}
/// Register before exposing a credential to any producer.
pub fn register_secret(secret: &str) {
    if secret.is_empty() {
        return;
    }
    let mut secrets = secrets().write();
    if !secrets.iter().any(|s| s == secret) {
        if secrets.len() == 256 {
            secrets.remove(0);
        }
        secrets.push(secret.into());
        secrets.sort_by_key(|s| std::cmp::Reverse(s.len()));
    }
}
fn sourced_secrets() -> &'static RwLock<std::collections::BTreeMap<String, String>> {
    static SOURCED: OnceLock<RwLock<std::collections::BTreeMap<String, String>>> = OnceLock::new();
    SOURCED.get_or_init(RwLock::default)
}
/// Replace rotated credentials from the same origin/header; placeholders stay literal.
pub fn register_secret_for(source: &str, secret: &str) {
    let mut secrets = sourced_secrets().write();
    if secret.len() < 16 {
        secrets.remove(source);
        return;
    }
    if secrets.len() >= 256 && !secrets.contains_key(source) {
        secrets.pop_first();
    }
    secrets.insert(source.into(), secret.into());
}
/// Register opaque path segments before any configured endpoint can be logged.
pub fn register_endpoint(input: &str) {
    let Ok(url) = url::Url::parse(input) else {
        return;
    };
    if let Some(segments) = url.path_segments() {
        for segment in segments {
            if segment.len() >= 16 {
                register_secret(segment);
                let decoded = percent_encoding::percent_decode_str(segment).decode_utf8_lossy();
                if decoded.len() >= 16 {
                    register_secret(&decoded);
                }
            }
        }
    }
}
fn scrub_text(text: &str) -> String {
    let mut text = text.to_owned();
    for secret in secrets().read().iter() {
        text = text.replace(secret, "[REDACTED]");
    }
    let mut sourced: Vec<_> = sourced_secrets().read().values().cloned().collect();
    sourced.sort_unstable_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
    sourced.dedup();
    for secret in sourced {
        text = text.replace(&secret, "[REDACTED]");
    }
    patterns::redact_log_line(&text)
}
pub fn redact_log_line(text: &str) -> String {
    redact_urls(&scrub_text(text))
}
pub fn redact_json(value: &Value) -> Value {
    scrub_value(value, false)
}
pub(crate) fn scrub_value(value: &Value, cap: bool) -> Value {
    match value {
        Value::String(s) => Value::String(if cap {
            bounded(&redact_log_line(s).replace("[redacted]", "[REDACTED]"))
        } else {
            redact_log_line(s).replace("[redacted]", "[REDACTED]")
        }),
        Value::Array(a) => Value::Array(a.iter().map(|v| scrub_value(v, cap)).collect()),
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, v)| {
                    (
                        bounded(&redact_log_line(k)),
                        if patterns::secret_key().is_match(k)
                            && !(k == "secrets_redacted" && v.is_boolean())
                        {
                            Value::String("[REDACTED]".into())
                        } else {
                            scrub_value(v, cap)
                        },
                    )
                })
                .collect(),
        ),
        v => v.clone(),
    }
}
pub(crate) fn bounded(s: &str) -> String {
    if s.len() <= 8192 {
        return s.into();
    }
    let mut end = 8192;
    loop {
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        let marker = format!("…truncated {} B", s.len() - end);
        if end + marker.len() <= 8192 {
            return format!("{}{marker}", &s[..end]);
        }
        end = 8192 - marker.len();
    }
}
pub fn redact_url(input: &str) -> String {
    let Ok(mut url) = url::Url::parse(input) else {
        return scrub_text(input);
    };
    let pairs: Vec<_> = url
        .query_pairs()
        .map(|(key, value)| {
            let secret = matches!(
                key.to_ascii_lowercase().as_str(),
                "key"
                    | "token"
                    | "api_key"
                    | "access_token"
                    | "code"
                    | "client_secret"
                    | "refresh_token"
                    | "signature"
                    | "sig"
                    | "x-amz-signature"
                    | "x-amz-credential"
                    | "x-amz-security-token"
                    | "x-goog-signature"
                    | "x-goog-credential"
            ) || patterns::secret_key().is_match(&key);
            (
                key.into_owned(),
                if secret {
                    "[REDACTED]".into()
                } else {
                    value.into_owned()
                },
            )
        })
        .collect();
    if !pairs.is_empty() {
        url.query_pairs_mut().clear().extend_pairs(pairs);
    }
    if !url.username().is_empty() {
        let _ = url.set_username("[REDACTED]");
    }
    if url.password().is_some() {
        let _ = url.set_password(Some("[REDACTED]"));
    }
    scrub_text(url.as_str())
}
fn redact_urls(s: &str) -> String {
    static URL: OnceLock<regex::Regex> = OnceLock::new();
    let regex = URL.get_or_init(|| butler_core::public_text::fixed_regex(r#"https?://[^\s"'<>]+"#));
    regex
        .replace_all(s, |c: &regex::Captures<'_>| redact_url(&c[0]))
        .into_owned()
}
pub fn redact_headers<'a>(headers: impl IntoIterator<Item = (&'a str, &'a str)>) -> Value {
    Value::Object(
        headers
            .into_iter()
            .map(|(name, value)| {
                let key = name.to_ascii_lowercase();
                let secret = matches!(
                    key.as_str(),
                    "authorization"
                        | "proxy-authorization"
                        | "x-api-key"
                        | "x-goog-api-key"
                        | "cookie"
                        | "set-cookie"
                );
                let allowed = matches!(
                    key.as_str(),
                    "content-type"
                        | "content-length"
                        | "x-request-id"
                        | "request-id"
                        | "retry-after"
                ) || key.starts_with("x-ratelimit-")
                    || key.starts_with("ratelimit-")
                    || key.starts_with("x-rate-limit-")
                    || key.starts_with("rate-limit-")
                    || key.starts_with("anthropic-ratelimit-");
                (
                    redact_log_line(&key),
                    if secret {
                        Value::String("[REDACTED]".into())
                    } else if allowed {
                        Value::String(redact_log_line(value))
                    } else {
                        Value::Null
                    },
                )
            })
            .collect(),
    )
}
