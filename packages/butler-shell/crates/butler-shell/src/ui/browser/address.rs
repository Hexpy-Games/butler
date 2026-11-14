//! Electron's browser/policy.mjs address policy.
use std::sync::LazyLock;

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use regex::Regex;
use url::Url;

const COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');
const LOCAL_SUFFIXES: [&str; 4] = [".localhost", ".local", ".home.arpa", ".internal"];

// JS: /^(\[[\da-f:.]+\]|[\w.-]+\.[a-z\d-]+|(?=[\d_-]*[a-z])[\w-]+(?=:\d|\/$)|localhost)(:\d+)?(\/|$)/iu
// Split the single-label alternative to express its lookaheads without lookaround.
static NAVIGABLE: LazyLock<Result<Regex, regex::Error>> = LazyLock::new(|| {
    Regex::new(
        r"(?i)^(?:(?:\[[0-9a-f:.]+\]|[a-z0-9_.-]+\.[a-z0-9-]+|localhost)(?::[0-9]+)?(?:/|$)|[0-9_-]*[a-z][a-z0-9_-]*(?::[0-9]+(?:/|$)|/$))",
    )
});
static PROTOCOL: LazyLock<Result<Regex, regex::Error>> =
    LazyLock::new(|| Regex::new(r"(?i)^[a-z][a-z0-9+.-]*:"));
static HOST_PORT: LazyLock<Result<Regex, regex::Error>> =
    LazyLock::new(|| Regex::new(r"^[a-zA-Z0-9_.-]+:[0-9]+(?:/|$)"));

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AddressError {
    Invalid,
    BlockedProtocol,
}

pub(crate) fn web_url(value: &str) -> Option<String> {
    let url = Url::parse(value).ok()?;
    (matches!(url.scheme(), "http" | "https")
        && url.username().is_empty()
        && url.password().is_none())
    .then(|| url.into())
}

pub(crate) fn address_url(input: &str) -> Result<Option<String>, AddressError> {
    if input.encode_utf16().count() > 8192 {
        return Err(AddressError::Invalid);
    }
    let value = input.trim_matches(js_whitespace);
    if value.is_empty() {
        return Ok(None);
    }
    if let Some(url) = web_url(value) {
        return Ok(Some(url));
    }
    let protocol = PROTOCOL.as_ref().map_err(|_| AddressError::Invalid)?;
    let host_port = HOST_PORT.as_ref().map_err(|_| AddressError::Invalid)?;
    if protocol.is_match(value) && !host_port.is_match(value) {
        return Err(AddressError::BlockedProtocol);
    }
    let navigable = NAVIGABLE.as_ref().map_err(|_| AddressError::Invalid)?;
    if !value.chars().any(js_whitespace) && navigable.is_match(value) {
        let plain = web_url(&format!("http://{value}"));
        let public = plain
            .as_ref()
            .and_then(|url| Url::parse(url).ok())
            .and_then(|url| url.host_str().map(|host| !local_host(host)))
            .unwrap_or(false);
        return Ok(if public {
            web_url(&format!("https://{value}"))
        } else {
            plain
        });
    }
    Ok(Some(format!(
        "https://www.google.com/search?q={}",
        utf8_percent_encode(value, COMPONENT)
    )))
}

fn js_whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
        | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn local_host(hostname: &str) -> bool {
    if let Some(ipv6) = hostname.strip_prefix('[') {
        let lead = ipv6
            .split(':')
            .next()
            .and_then(|part| u16::from_str_radix(part, 16).ok())
            .unwrap_or(0);
        return hostname == "[::1]" || (lead & 0xfe00) == 0xfc00 || (lead & 0xffc0) == 0xfe80;
    }
    if hostname
        .bytes()
        .all(|byte| byte.is_ascii_digit() || byte == b'.')
    {
        let mut parts = hostname
            .split('.')
            .filter_map(|part| part.parse::<u16>().ok());
        let a = parts.next();
        let b = parts.next();
        return matches!(a, Some(127 | 10))
            || matches!(
                (a, b),
                (Some(172), Some(16..=31))
                    | (Some(192), Some(168))
                    | (Some(169), Some(254))
                    | (Some(100), Some(64..=127))
            );
    }
    !hostname.contains('.')
        || LOCAL_SUFFIXES
            .iter()
            .any(|suffix| hostname.ends_with(suffix))
}
