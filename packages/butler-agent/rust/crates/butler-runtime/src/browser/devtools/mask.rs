//! Masking applied before DevTools data leaves the browser host's reply: names
//! that carry credentials on every tab, and everything account-bound on a
//! signed-in one.
use super::names::{credential_name, secret_parameter};
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
/// `key: value`, `key=value`, `"key":"value"`, also with escaped quotes: a quoted
/// value runs to its closing quote.
static NAMED: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(r#"(\\?["']?)([\p{L}_][\w.\-]{0,80})(\\?["']?\s*[:=：]\s*)(\\"(?:[^"\\\n]|\\[^"\n])*(?:\\")?|"[^"\n]*"?|'[^'\n]*'?|[^\s"'&;,\\]+)"#).ok()
});
/// An unquoted secret phrase has no end but its clause.
static PHRASE: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(r#"(?i)([\w.-]*(?:passw(?:or)?d|passphrase|passcode|pwd|secret|비밀번호|암호|パスワード|密码|密碼)[\w.-]*)(\s*[:=：]\s*)([^"'\\\s][^\n,;&]*)"#).ok()
});
/// Keys that say what they are, whatever surrounds them.
static RAW_KEY: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(r"\b(?:gh[pousr]_[A-Za-z0-9]{10,}|github_pat_\w{10,}|sk-[A-Za-z0-9_-]{10,}|[sr]k_(?:live|test)_\w{8,}|xox[abeoprs]-[\w-]{8,}|(?:AKIA|ASIA)[A-Z0-9]{12,}|AIza[\w-]{20,}|glpat-[\w-]{10,}|npm_[A-Za-z0-9]{20,})").ok()
});
static URLS: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r#"https?://[^\s"'<>)\]]+"#).ok());

/// Whether a parameter's value, read once decoded, holds a credential: a return
/// URL that carries a token, say. Checked flat, so nesting can't deepen the work.
fn secret_value(value: &str) -> bool {
    let decoded: String = url::form_urlencoded::parse(format!("v={value}").as_bytes())
        .next()
        .map(|(_, decoded)| decoded.into_owned())
        .unwrap_or_default();
    named(&decoded) != decoded
        || [&BEARER, &JWT, &RAW_KEY]
            .iter()
            .any(|regex| regex.as_ref().is_none_or(|regex| regex.is_match(&decoded)))
}

fn parameter(pair: &str, masked: bool) -> String {
    let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
    if value.is_empty() && !pair.contains('=') {
        return if masked {
            MASK.to_owned()
        } else {
            pair.to_owned()
        };
    }
    if masked || secret_parameter(name) || secret_value(value) {
        format!("{name}={MASK}")
    } else {
        pair.to_owned()
    }
}

/// Parameters split on `&` and on `;`, the older separator servers still honour.
fn parameters(raw: &str, masked: bool) -> String {
    let mut out = String::new();
    let mut start = 0;
    for (index, separator) in raw.match_indices(['&', ';']) {
        out.push_str(&parameter(&raw[start..index], masked));
        out.push_str(separator);
        start = index + separator.len();
    }
    out.push_str(&parameter(&raw[start..], masked));
    out
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

/// Masks every `key: value` whose key names a credential. Under any other key
/// the scan carries on inside the value, so a nested pair cannot hide. An error
/// class's name is not a key, whatever words it holds.
fn named(text: &str) -> String {
    let Some(regex) = NAMED.as_ref() else {
        return MASK.to_owned();
    };
    let mut out = String::new();
    let mut at = 0;
    while let Some(found) = regex.captures_at(text, at) {
        let (Some(whole), Some(key), Some(value)) = (found.get(0), found.get(2), found.get(4))
        else {
            break;
        };
        out.push_str(&text[at..value.start()]);
        let error_name = key.as_str().ends_with("Error") || key.as_str().ends_with("Exception");
        if credential_name(key.as_str()) && !error_name {
            out.push_str(MASK);
            at = whole.end();
        } else {
            at = value.start();
        }
    }
    out.push_str(&text[at..]);
    out
}

/// Page text with anything shaped like a credential removed, bounded and
/// saying how much it left out.
pub(crate) fn mask_text(text: &str, masked: bool) -> String {
    let text = replaced(&SET_COOKIE, text, |c| format!("{}: {MASK}", &c[1]));
    let text = replaced(&BEARER, &text, |c| format!("{} {MASK}", &c[1]));
    let text = replaced(&JWT, &text, |_| MASK.to_owned());
    let text = replaced(&RAW_KEY, &text, |_| MASK.to_owned());
    let text = replaced(&URLS, &text, |c| mask_url(&c[0], masked));
    let text = replaced(&PHRASE, &text, |c| format!("{}{}{MASK}", &c[1], &c[2]));
    let text = named(&text);
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
