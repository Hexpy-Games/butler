//! Upload routing follows bytes, retaining only safe and compatible MIME declarations.
use super::names;
use butler_core::public_text::is_unicode_text;

pub(super) fn classify(
    declared: Option<&str>,
    safe_name: &str,
    bytes: &[u8],
) -> (&'static str, String) {
    let mut mime = names::normalized_mime(declared.unwrap_or(""), safe_name);
    if !well_formed(&mime) {
        mime.clear();
    }
    if matches!(
        mime.as_str(),
        "image/png" | "image/jpeg" | "image/webp" | "image/gif"
    ) {
        return ("image", mime);
    }
    if bytes.starts_with(b"%PDF-") {
        return ("generic", "application/pdf".into());
    }
    if is_unicode_text(bytes) {
        if matches!(
            mime.as_str(),
            "" | "application/octet-stream" | "application/pdf"
        ) {
            mime = "text/plain".into();
        }
        return ("text", mime);
    }
    if mime.is_empty() || mime == "application/pdf" || text_like(&mime) {
        mime = "application/octet-stream".into();
    }
    ("generic", mime)
}
fn well_formed(mime: &str) -> bool {
    let Some((major, minor)) = mime.split_once('/') else {
        return false;
    };
    [major, minor].into_iter().all(|part| {
        (1..=127).contains(&part.len())
            && part
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphanumeric)
            && part
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"!#$&^_.+-".contains(&c))
    })
}
fn text_like(mime: &str) -> bool {
    mime.starts_with("text/")
        || mime.ends_with("+json")
        || mime.ends_with("+xml")
        || matches!(
            mime,
            "application/json"
                | "application/xml"
                | "application/yaml"
                | "application/x-yaml"
                | "application/javascript"
                | "application/typescript"
                | "application/markdown"
                | "application/toml"
                | "application/x-sh"
                | "application/x-ndjson"
        )
}
