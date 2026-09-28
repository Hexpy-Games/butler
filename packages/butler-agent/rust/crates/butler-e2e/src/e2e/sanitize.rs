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
//! 5. Account identifiers in JSON bodies (`account_id`, `user_id`,
//!    `email`, … as usage endpoints return them) become `{{ACCOUNT}}` /
//!    `{{EMAIL}}` (`redact_identifiers`).

use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;

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
        self.0.sort_by(|a, b| b.1.len().cmp(&a.1.len()));
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

/// JSON fields that identify an account; their values never reach a cassette.
const IDENTIFIER_FIELDS: &[&str] = &[
    "account_id",
    "accountId",
    "user_id",
    "userId",
    "workspace_id",
    "workspaceId",
    "org_id",
    "organization_id",
    "email",
];

/// An identifier field with a value that is not a placeholder, in raw or
/// JSON-string-escaped form.
fn identifier_field() -> Option<&'static Regex> {
    static FIELD: OnceLock<Option<Regex>> = OnceLock::new();
    FIELD
        .get_or_init(|| {
            let names = IDENTIFIER_FIELDS.join("|");
            Regex::new(&format!(r#"\\?"(?:{names})\\?"\s*:\s*\\?"[^{{\\"]"#)).ok()
        })
        .as_ref()
}

/// Replaces identifier field values anywhere in a JSON value.
pub fn redact_identifiers(value: &mut Value) -> bool {
    match value {
        Value::Object(object) => {
            let mut changed = false;
            for (key, field) in object.iter_mut() {
                if IDENTIFIER_FIELDS.contains(&key.as_str())
                    && field.as_str().is_some_and(|text| !text.starts_with("{{"))
                {
                    let placeholder = if key == "email" {
                        "{{EMAIL}}"
                    } else {
                        "{{ACCOUNT}}"
                    };
                    *field = Value::String(placeholder.into());
                    changed = true;
                } else {
                    changed |= redact_identifiers(field);
                }
            }
            changed
        }
        Value::Array(items) => items
            .iter_mut()
            .fold(false, |changed, item| redact_identifiers(item) || changed),
        _ => false,
    }
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
    if let Some(found) = identifier_field().and_then(|regex| regex.find(text)) {
        let excerpt: String = found.as_str().chars().take(16).collect();
        findings.push(format!("identifier field: {excerpt}…"));
    }
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
    let mut out = String::with_capacity(body.len());
    for line in body.split_inclusive('\n') {
        let (content, newline) = match line.strip_suffix('\n') {
            Some(content) => (content, "\n"),
            None => (line, ""),
        };
        if let Some(data) = content.strip_prefix("data: ")
            && let Ok(mut value) = serde_json::from_str::<Value>(data)
            && (redact_echo(&mut value) | redact_identifiers(&mut value))
        {
            out.push_str("data: ");
            out.push_str(&value.to_string());
            out.push_str(newline);
            continue;
        }
        out.push_str(line);
    }
    if let Ok(mut value) = serde_json::from_str::<Value>(&out)
        && (redact_echo(&mut value) | redact_identifiers(&mut value))
    {
        out = value.to_string();
    }
    scrub(&placeholders.hide(&out))
}
