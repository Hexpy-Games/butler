//! Shared attachment identity, routing and model-facing fallback text.
use butler_core::public_text::{decode_unicode_text, trim_js_whitespace};
use butler_turn::btcc::{AttachmentKind, AttachmentRef};
use std::{
    borrow::Cow,
    path::{Path, PathBuf},
};

pub const MAX_INLINE_BYTES: u64 = 512_000;

pub fn display_name(a: &AttachmentRef, index: usize) -> String {
    a.file_name
        .as_deref()
        .map(trim_js_whitespace)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("attachment-{}", index + 1))
}
fn mime(a: &AttachmentRef) -> &str {
    a.mime_type
        .as_deref()
        .map(trim_js_whitespace)
        .filter(|m| !m.is_empty())
        .unwrap_or("application/octet-stream")
}
fn size(a: &AttachmentRef) -> String {
    a.size_bytes
        .filter(|n| n.is_finite())
        .map(|n| format!("{} bytes", ryu_js::Buffer::new().format_finite(n)))
        .unwrap_or_else(|| "unknown size".into())
}
pub fn listing_line(a: &AttachmentRef, index: usize, path: Option<&Path>) -> String {
    let kind = match a.kind {
        AttachmentKind::Image => "image",
        AttachmentKind::Audio => "audio",
        AttachmentKind::Video => "video",
        AttachmentKind::Document => "document",
        AttachmentKind::Binary => "binary",
    };
    let path = path
        .filter(|_| a.kind != AttachmentKind::Image)
        .map(|p| format!(", path: {}", p.display()))
        .unwrap_or_default();
    format!(
        "- {} ({kind}, {}, {}, id: {}{path})",
        display_name(a, index),
        mime(a),
        size(a),
        a.id
    )
}
#[derive(Clone, Copy)]
pub enum NotInlined {
    Format,
    TooLarge,
    Budget,
    Unreadable,
}

pub fn not_inlined_block(
    a: &AttachmentRef,
    index: usize,
    path: Option<&Path>,
    reason: NotInlined,
) -> String {
    let reason = match reason {
        NotInlined::Format => "not decoded as text",
        NotInlined::TooLarge => "larger than the 512000-byte inline limit",
        NotInlined::Budget => "inline attachment text limit for this message reached",
        NotInlined::Unreadable => "the file could not be read",
    };
    let location = path
        .map(|p| format!("Path: {}\n", p.display()))
        .unwrap_or_default();
    let instruction = if path.is_some() {
        " If the request needs it, read or convert the file at this path with your tools."
    } else {
        ""
    };
    format!(
        "### Attachment Not Inlined: {}\nAttachment ID: {}\nType: {}, {}\n{location}Its content is not shown inline ({reason}).{instruction}",
        display_name(a, index),
        a.id,
        mime(a),
        size(a)
    )
}
pub fn is_pdf(a: &AttachmentRef) -> bool {
    match a.mime_type.as_deref() {
        Some(mime) => mime
            .split(';')
            .next()
            .is_some_and(|m| trim_js_whitespace(m).eq_ignore_ascii_case("application/pdf")),
        None => a
            .file_name
            .as_deref()
            .is_some_and(|n| n.to_ascii_lowercase().ends_with(".pdf")),
    }
}
pub fn is_text(a: &AttachmentRef) -> bool {
    match a.kind {
        AttachmentKind::Document => return true,
        AttachmentKind::Image | AttachmentKind::Binary => return false,
        _ => {}
    }
    if let Some(mime) = &a.mime_type {
        let mime = mime
            .split(';')
            .next()
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        return mime.starts_with("text/")
            || mime.ends_with("+json")
            || mime.ends_with("+xml")
            || matches!(
                mime.as_str(),
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
            );
    }
    Path::new(a.file_name.as_deref().unwrap_or_default())
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| {
            matches!(
                e.to_ascii_lowercase().as_str(),
                "md" | "markdown"
                    | "txt"
                    | "json"
                    | "jsonl"
                    | "yaml"
                    | "yml"
                    | "xml"
                    | "csv"
                    | "tsv"
                    | "js"
                    | "jsx"
                    | "ts"
                    | "tsx"
                    | "css"
                    | "html"
            )
        })
}
pub fn decode_text(bytes: &[u8]) -> Cow<'_, str> {
    decode_unicode_text(bytes)
        .unwrap_or_else(|| Cow::Owned(String::from_utf8_lossy(bytes).replace('\0', "")))
}
pub fn message_file_path(butler_data: &Path, attachment: &AttachmentRef) -> Option<PathBuf> {
    let id = &attachment.id;
    let suffix = id.strip_prefix("file-")?;
    if suffix.len() != 36 || !suffix.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
        return None;
    }
    let upload = format!("{id}.upload");
    // The admitted metadata selects the storage generation, never an arbitrary
    // path. Both generations remain rooted in this data owner's file directory.
    let storage = if attachment
        .local_path
        .as_deref()
        .and_then(|path| Path::new(path).file_name())
        .is_some_and(|name| name == upload.as_str())
    {
        upload.as_str()
    } else {
        id.as_str()
    };
    Some(
        butler_data
            .join("app-server")
            .join("message-files")
            .join(storage),
    )
}
