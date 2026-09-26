//! Source attachment name, MIME, and kind rules.

use std::sync::LazyLock;

use regex::Regex;

use crate::public_text::trim_js_whitespace;

static UNSAFE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[^\p{L}\p{N}_ .@()+\-\[\]]+").expect("constant name expression"));
static TEXT_SUFFIX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\.(?:txt|md|markdown|json|ya?ml|jsx?|tsx?|css|html?|xml|csv|log|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|sh|zsh|toml|ini)$")
        .expect("constant text extension expression")
});

pub(super) struct SafeName {
    pub(super) units: Vec<u16>,
    pub(super) stored: String,
}

pub(super) fn safe_name(value: &str) -> SafeName {
    let path_free = value
        .split(['/', '\\'])
        .filter(|part| !part.is_empty())
        .next_back()
        .unwrap_or("attachment");
    let cleaned = UNSAFE.replace_all(path_free, "_");
    let trimmed = trim_js_whitespace(&cleaned);
    let normalized = if trimmed.is_empty() || matches!(trimmed, "." | "..") {
        "attachment"
    } else {
        trimmed
    };
    let units: Vec<u16> = normalized.encode_utf16().take(120).collect();
    // Bun SQLite binds a split UTF-16 surrogate as WTF-8. Reading the TEXT
    // column back exposes three replacement characters for that one unit.
    let mut stored = String::new();
    for unit in char::decode_utf16(units.iter().copied()) {
        match unit {
            Ok(character) => stored.push(character),
            Err(_) => stored.push_str("\u{fffd}\u{fffd}\u{fffd}"),
        }
    }
    SafeName { units, stored }
}

pub(super) fn mime_for_path(path: &str) -> &'static str {
    let lower = path.to_lowercase();
    if lower.ends_with(".md") || lower.ends_with(".txt") {
        "text/plain"
    } else if lower.ends_with(".json") {
        "application/json"
    } else if lower.ends_with(".csv") {
        "text/csv"
    } else if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".pdf") {
        "application/pdf"
    } else {
        "application/octet-stream"
    }
}

pub(super) fn normalized_mime(provided: &str, safe_name: &str) -> String {
    let value = trim_js_whitespace(provided.split(';').next().unwrap_or("")).to_lowercase();
    let lower = safe_name.to_lowercase();
    if (value.is_empty() || value == "application/octet-stream") && lower.ends_with(".pdf") {
        return "application/pdf".into();
    }
    if !value.is_empty() {
        return value;
    }
    for (suffix, mime) in [
        (".png", "image/png"),
        (".jpg", "image/jpeg"),
        (".jpeg", "image/jpeg"),
        (".webp", "image/webp"),
        (".gif", "image/gif"),
        (".json", "application/json"),
    ] {
        if lower.ends_with(suffix) {
            return mime.into();
        }
    }
    if TEXT_SUFFIX.is_match(&lower) {
        "text/plain".into()
    } else {
        "application/octet-stream".into()
    }
}

pub(super) fn kind(mime: &str, safe_name: &str) -> &'static str {
    if matches!(
        mime,
        "image/png" | "image/jpeg" | "image/webp" | "image/gif"
    ) {
        "image"
    } else if mime == "application/pdf" || safe_name.to_lowercase().ends_with(".pdf") {
        "generic"
    } else if mime.starts_with("text/")
        || mime == "application/json"
        || TEXT_SUFFIX.is_match(safe_name)
    {
        "text"
    } else {
        "generic"
    }
}
