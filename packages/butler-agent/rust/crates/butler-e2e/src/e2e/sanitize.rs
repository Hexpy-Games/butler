//! Sanitization of recorded traffic, run at record time, and the cassette
//! lint that re-checks every committed cassette (see `tests/cassette_lint.rs`).
//!
//! Transformations (each listed in a cassette's `meta.sanitization`):
//! 1. Per-run values registered by the scenario (workspace path, data dir,
//!    nonces) become `{{NAME}}` placeholders; replay substitutes them back.
//! 2. JWTs, `sk-` style keys, bearer strings, emails, the recording machine's
//!    home directory and host name become fixed placeholders.
//! 3. Echoes of the request's instructions and tool list in response events
//!    (`response.instructions`, `response.tools`) are replaced by
//!    `{{REDACTED_ECHO}}` / `[]`: they repeat the prompt (~18 KB) and carry
//!    nothing the product reads back.
//! 4. Response headers are reduced to an allowlist plus the numeric
//!    subscription-quota headers the product parses (`keep_header`).
//! 5. JSON body fields (usage and token endpoints): account identifiers
//!    become `{{ACCOUNT}}` / `{{EMAIL}}`, tokens `{{TOKEN}}`, and absolute
//!    reset times relative placeholders rounded to the hour (`fields`).

use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;

mod fields;

pub const HEADER_ALLOWLIST: &[&str] = &["content-type", "retry-after"];

/// Quota headers kept when their value is a plain number: Codex usage
/// windows and Anthropic unified rate-limit windows.
pub const QUOTA_HEADER_PREFIXES: &[&str] = &[
    "x-codex-primary-",
    "x-codex-secondary-",
    "anthropic-ratelimit-unified-",
];

/// Whether a response header is kept in the cassette.
pub fn keep_header(name: &str, value: &str) -> bool {
    HEADER_ALLOWLIST.contains(&name)
        || (QUOTA_HEADER_PREFIXES
            .iter()
            .any(|prefix| name.starts_with(prefix))
            && value.trim().parse::<f64>().is_ok_and(f64::is_finite))
}

/// Scenario placeholders: `(NAME, value)`; `{{NAME}}` in cassettes.
#[derive(Clone, Debug, Default)]
pub struct Placeholders(pub Vec<(String, String)>);

impl Placeholders {
    pub fn add(&mut self, name: &str, value: impl Into<String>) {
        let value = value.into();
        if value.is_empty() {
            return;
        }
        self.0.retain(|(existing, _)| existing != name);
        self.0.push((name.to_owned(), value));
        // Longest values first so a path is replaced before its prefix.
        self.0.sort_by_key(|item| std::cmp::Reverse(item.1.len()));
    }

    /// Value → `{{NAME}}`.
    pub fn hide(&self, text: &str) -> String {
        let mut out = text.to_owned();
        for (name, value) in &self.0 {
            out = out.replace(value.as_str(), &format!("{{{{{name}}}}}"));
        }
        out
    }

    /// `{{NAME}}` → value (JSON-string-escaped when `json_escape`).
    pub fn reveal(&self, text: &str, json_escape: bool) -> String {
        let mut out = text.to_owned();
        for (name, value) in &self.0 {
            let value = if json_escape {
                let quoted = Value::String(value.clone()).to_string();
                quoted[1..quoted.len() - 1].to_owned()
            } else {
                value.clone()
            };
            out = out.replace(&format!("{{{{{name}}}}}"), &value);
        }
        out
    }
}

/// Secret and personal-data patterns: `(label, regex, replacement)`.
fn patterns() -> &'static [(&'static str, Regex, &'static str)] {
    static PATTERNS: OnceLock<Vec<(&'static str, Regex, &'static str)>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            (
                "jwt",
                r"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*",
                "{{JWT}}",
            ),
            ("key", r"\b(?:sk|rk|pk|sess)-[A-Za-z0-9_-]{16,}", "{{KEY}}"),
            (
                "bearer",
                r"(?i)bearer\s+[A-Za-z0-9._~+/=-]{12,}",
                "Bearer {{TOKEN}}",
            ),
            (
                "email",
                r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}",
                "{{EMAIL}}",
            ),
            (
                "user path",
                r"/(?:Users|home)/[A-Za-z0-9._-]+",
                "{{HOST_HOME}}",
            ),
            ("account id", r"\buser-[A-Za-z0-9]{16,}", "{{ACCOUNT}}"),
            ("zai key", r"\b[0-9a-f]{32}\.[A-Za-z0-9]{16}\b", "{{KEY}}"),
            (
                "authorization",
                r#"(?i)authorization\\?"?\s*[:,]\s*\\?"?\s*[A-Za-z0-9._~+/=-]{12,}"#,
                "authorization: {{TOKEN}}",
            ),
        ]
        .into_iter()
        .filter_map(|(label, pattern, replacement)| {
            Regex::new(pattern)
                .ok()
                .map(|regex| (label, regex, replacement))
        })
        .collect()
    })
}

/// Generic secret/personal-data scrub applied after scenario placeholders.
pub fn scrub(text: &str) -> String {
    let mut out = text.to_owned();
    for (_, regex, replacement) in patterns() {
        out = regex.replace_all(&out, *replacement).into_owned();
    }
    if let Some(host) = host_name() {
        out = out.replace(&host, "{{HOSTNAME}}");
    }
    out
}

fn host_name() -> Option<String> {
    butler_platform::instance::host_name()
        .ok()
        .filter(|name| name.len() >= 4)
}

/// Replaces identifier, token and absolute reset-time values anywhere in a
/// JSON value recorded now (see [`fields`]).
pub fn redact_identifiers(value: &mut Value) -> bool {
    fields::redact(value, now_ms())
}

/// The current time in epoch milliseconds (recording and replay time).
pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Replay: relative reset-time placeholders → times relative to `now_ms`.
pub fn expand_times(text: &str, now_ms: i64) -> String {
    fields::expand_times(text, now_ms)
}

/// Whether a UUID at `start` in `text` is a prompt cache key (a per-install
/// cache partition the request echoes, not an account identifier).
fn prompt_cache_key(text: &str, start: usize) -> bool {
    let before = &text[..start];
    let window = &before[before.len().saturating_sub(24)..];
    window.contains("prompt_cache_key")
}

/// Stable, same-width aliases for opaque UUIDs, including identifiers embedded
/// in tool argument strings. Keeping the byte width preserves SSE chunk boundaries.
pub fn normalize_opaque_ids(text: &str) -> String {
    static UUID: OnceLock<Option<Regex>> = OnceLock::new();
    let Some(uuid) = UUID.get_or_init(|| {
        Regex::new(r"(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b").ok()
    }) else {
        return text.to_owned();
    };
    uuid.replace_all(text, |found: &regex::Captures<'_>| {
        let identifier = &found[0];
        if prompt_cache_key(text, found.get(0).map_or(0, |value| value.start())) {
            identifier.to_owned()
        } else {
            let hash = super::sha256_hex(identifier.to_ascii_lowercase().as_bytes());
            format!("opaque-{}", &hash[..29])
        }
    })
    .into_owned()
}

fn uuid_finding(text: &str) -> Option<String> {
    static UUID: OnceLock<Option<Regex>> = OnceLock::new();
    let uuid = UUID
        .get_or_init(|| {
            Regex::new(r"(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b").ok()
        })
        .as_ref()?;
    uuid.find_iter(text)
        .find(|found| !prompt_cache_key(text, found.start()))
        .map(|found| format!("uuid: {}…", &found.as_str()[..8]))
}

/// Findings of the lint on one text (empty when clean).
pub fn lint(text: &str) -> Vec<String> {
    let mut findings = Vec::new();
    for (label, regex, _) in patterns() {
        if let Some(found) = regex.find(text) {
            let excerpt: String = found.as_str().chars().take(12).collect();
            findings.push(format!("{label}: {excerpt}…"));
        }
    }
    findings.extend(fields::lint(text));
    findings.extend(uuid_finding(text));
    for canary in ["e2e-canary-", "E2E_CANARY"] {
        if text.contains(canary) {
            findings.push(format!("canary {canary}"));
        }
    }
    findings
}

/// Replaces prompt/tool echoes inside one SSE `data:` JSON event.
pub fn redact_echo(event: &mut Value) -> bool {
    let mut changed = false;
    for pointer in ["/response", ""] {
        let Some(object) = event.pointer_mut(pointer).and_then(Value::as_object_mut) else {
            continue;
        };
        if let Some(value) = object.get_mut("instructions")
            && value.is_string()
        {
            *value = Value::String("{{REDACTED_ECHO}}".into());
            changed = true;
        }
        for field in ["safety_identifier", "user"] {
            if let Some(value) = object.get_mut(field)
                && value.is_string()
            {
                *value = Value::String("{{ACCOUNT}}".into());
                changed = true;
            }
        }
        if let Some(value) = object.get_mut("tools")
            && value.as_array().is_some_and(|tools| !tools.is_empty())
        {
            *value = Value::Array(Vec::new());
            changed = true;
        }
    }
    changed
}

/// Sanitizes a complete SSE or JSON body: echoes, placeholders, scrub.
pub fn sanitize_body(body: &str, placeholders: &Placeholders) -> String {
    sanitize_body_at(body, placeholders, now_ms())
}

/// [`sanitize_body`] for a body received at `recorded_ms` (re-sanitizing an
/// older recording keeps its reset times relative to when it was recorded).
pub fn sanitize_body_at(body: &str, placeholders: &Placeholders, recorded_ms: i64) -> String {
    let redact = |value: &mut Value| redact_echo(value) | fields::redact(value, recorded_ms);
    let mut out = String::with_capacity(body.len());
    for line in body.split_inclusive('\n') {
        let (content, newline) = match line.strip_suffix('\n') {
            Some(content) => (content, "\n"),
            None => (line, ""),
        };
        if let Some(data) = content.strip_prefix("data: ")
            && let Ok(mut value) = serde_json::from_str::<Value>(data)
            && redact(&mut value)
        {
            out.push_str("data: ");
            out.push_str(&value.to_string());
            out.push_str(newline);
            continue;
        }
        out.push_str(line);
    }
    if let Ok(mut value) = serde_json::from_str::<Value>(&out)
        && redact(&mut value)
    {
        out = value.to_string();
    }
    scrub(&placeholders.hide(&out))
}
