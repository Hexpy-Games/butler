//! Masking applied before DevTools data leaves the browser host's reply: names
//! that carry credentials on every tab, and everything account-bound on a
//! signed-in one.
use regex::{Captures, Regex};
use serde_json::{Map, Value};
use std::sync::LazyLock;

pub(crate) const MASK: &str = "[masked]";
const TEXT_LIMIT: usize = 2000;
const SIGNED_IN_TEXT_LIMIT: usize = 500;
const URL_LIMIT: usize = 2000;

static SET_COOKIE: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"(?i)\b(set-cookie|cookie)\s*[:=][^\n]*").ok());
static BEARER: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}").ok());
static JWT: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(r"\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]+)?").ok()
});
static NAMED: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(r#"(?i)([\w.-]*(?:token|secret|passw(?:or)?d|pwd|session|csrf|xsrf|api[-_]?key|authorization|credential)[\w.-]*)(["']?\s*[:=]\s*["']?)([^\s"'&;,]+)"#).ok()
});
static URLS: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r#"https?://[^\s"'<>)\]]+"#).ok());

fn words(name: &str) -> Vec<String> {
    let mut words = vec![String::new()];
    let mut previous_lower = false;
    for ch in name.chars() {
        if !ch.is_alphanumeric() {
            words.push(String::new());
            previous_lower = false;
            continue;
        }
        if ch.is_uppercase() && previous_lower {
            words.push(String::new());
        }
        previous_lower = ch.is_lowercase();
        if let Some(word) = words.last_mut() {
            word.extend(ch.to_lowercase());
        }
    }
    words
}

/// Whether a header, field, attribute or parameter name carries a credential.
pub(crate) fn credential_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let strong = [
        "token",
        "secret",
        "passw",
        "pwd",
        "passphrase",
        "cookie",
        "session",
        "csrf",
        "xsrf",
        "credential",
        "apikey",
        "api-key",
        "api_key",
        "accesskey",
        "signature",
        "jwt",
        "bearer",
    ];
    strong.iter().any(|needle| lower.contains(needle))
        || lower.contains("auth") && !lower.contains("author")
        || lower.contains("authorization")
        || words(name)
            .iter()
            .any(|word| matches!(word.as_str(), "key" | "sig" | "sid" | "otp" | "pin"))
}

/// Query and fragment parameters that also carry one-time secrets in URLs.
fn secret_parameter(name: &str) -> bool {
    credential_name(name)
        || matches!(
            name.to_ascii_lowercase().as_str(),
            "code" | "state" | "nonce"
        )
}

fn parameters(raw: &str, masked: bool) -> String {
    raw.split('&')
        .map(|pair| {
            let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
            if value.is_empty() && !pair.contains('=') {
                return if masked {
                    MASK.to_owned()
                } else {
                    pair.to_owned()
                };
            }
            if masked || secret_parameter(name) {
                format!("{name}={MASK}")
            } else {
                pair.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join("&")
}

fn token_like(segment: &str) -> bool {
    segment.len() >= 24
        && segment
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~'))
        && segment.bytes().any(|b| b.is_ascii_digit())
}

fn capped(mut text: String, limit: usize) -> String {
    let total = text.chars().count();
    if total > limit {
        text = text.chars().take(limit).collect();
        text.push_str(&format!("…[+{} chars]", total - limit));
    }
    text
}

/// The path, query and fragment of a URL, as shown.
fn location(url: &url::Url, masked: bool) -> String {
    let mut out = if masked {
        url.path()
            .split('/')
            .map(|part| if token_like(part) { MASK } else { part })
            .collect::<Vec<_>>()
            .join("/")
    } else {
        url.path().to_owned()
    };
    if let Some(query) = url.query() {
        out.push('?');
        out.push_str(&parameters(query, masked));
    }
    if let Some(fragment) = url.fragment() {
        out.push('#');
        if masked {
            out.push_str(MASK);
        } else if fragment.contains('=') {
            out.push_str(&parameters(fragment, false));
        } else {
            out.push_str(fragment);
        }
    }
    out
}

/// A URL with its credentials removed: userinfo always, credential parameters
/// always; on a signed-in tab every query value and token-like path segment.
/// A relative one keeps its form; what cannot be read as a URL is not shown.
pub(crate) fn mask_url(raw: &str, masked: bool) -> String {
    let url = match url::Url::parse(raw) {
        Ok(url) => url,
        Err(url::ParseError::RelativeUrlWithoutBase) => {
            let joined = url::Url::parse("http://relative.invalid/")
                .ok()
                .and_then(|base| base.join(raw).ok());
            return joined.map_or_else(
                || MASK.to_owned(),
                |url| capped(location(&url, masked), URL_LIMIT),
            );
        }
        Err(_) => return MASK.to_owned(),
    };
    if !matches!(url.scheme(), "http" | "https") {
        return format!("{}:[{} chars]", url.scheme(), raw.len());
    }
    let origin = url.origin().ascii_serialization();
    if url.host_str().is_some_and(super::super::payment_host) {
        return format!("{origin}/{MASK}");
    }
    capped(format!("{origin}{}", location(&url, masked)), URL_LIMIT)
}

fn replaced(
    regex: &LazyLock<Option<Regex>>,
    text: &str,
    with: impl Fn(&Captures<'_>) -> String,
) -> String {
    match regex.as_ref() {
        Some(regex) => regex
            .replace_all(text, |c: &Captures<'_>| with(c))
            .into_owned(),
        // A pattern that failed to build fails closed: nothing passes unread.
        None => MASK.to_owned(),
    }
}

/// Page text with anything shaped like a credential removed, bounded and
/// saying how much it left out.
pub(crate) fn mask_text(text: &str, masked: bool) -> String {
    let text = replaced(&SET_COOKIE, text, |c| format!("{}: {MASK}", &c[1]));
    let text = replaced(&BEARER, &text, |c| format!("{} {MASK}", &c[1]));
    let text = replaced(&JWT, &text, |_| MASK.to_owned());
    let text = replaced(&NAMED, &text, |c| format!("{}{}{MASK}", &c[1], &c[2]));
    let text = replaced(&URLS, &text, |c| mask_url(&c[0], masked));
    capped(
        text,
        if masked {
            SIGNED_IN_TEXT_LIMIT
        } else {
            TEXT_LIMIT
        },
    )
}

/// Headers as the model may see them: credential values never; on a signed-in
/// tab no header at all.
pub(crate) fn mask_headers(headers: &Value, masked: bool) -> Option<Value> {
    if masked {
        return None;
    }
    let shown: Map<String, Value> = headers
        .as_object()?
        .iter()
        .map(|(name, value)| {
            let value = if credential_name(name) {
                Value::String(MASK.to_owned())
            } else {
                Value::String(mask_text(value.as_str().unwrap_or(""), false))
            };
            (name.clone(), value)
        })
        .collect();
    (!shown.is_empty()).then_some(Value::Object(shown))
}
