use std::path::{Path, PathBuf};

use crate::{
    btcc::{AttachmentKind, AttachmentRef, ModelRoundError},
    models::ProviderPromptRequest,
};

const MAX_ATTACHMENT_TEXT_UNITS: usize = 24_000;
const MAX_TOTAL_TEXT_UNITS: usize = 60_000;
const MAX_ATTACHMENT_BYTES: u64 = 512_000;

pub(super) fn prompt(request: &ProviderPromptRequest<'_>) -> Result<String, ModelRoundError> {
    if request
        .attachments
        .iter()
        .any(|value| value.kind == AttachmentKind::Image)
    {
        return Err(failure(
            "verified_image_payload_port_required",
            "Verified image payload is required for prompt serialization.",
        ));
    }
    let attachments = request
        .attachments
        .iter()
        .filter(|value| !value.id.is_empty())
        .take(12)
        .collect::<Vec<_>>();
    if attachments.is_empty() {
        return Ok(request.prompt.into());
    }
    let root = data_root(request.butler_data);
    let mut context = String::from("## Attachments");
    for (index, attachment) in attachments.iter().enumerate() {
        context.push_str("\n- ");
        context.push_str(&name(attachment, index));
        context.push_str(" (");
        context.push_str(kind(&attachment.kind));
        context.push_str(", ");
        context.push_str(
            attachment
                .mime_type
                .as_deref()
                .map(crate::public_text::trim_js_whitespace)
                .filter(|value| !value.is_empty())
                .unwrap_or("application/octet-stream"),
        );
        context.push_str(", ");
        context.push_str(&size(attachment.size_bytes));
        context.push_str(", id: ");
        context.push_str(&attachment.id);
        context.push(')');
    }
    let mut remaining = MAX_TOTAL_TEXT_UNITS;
    for (index, attachment) in attachments.iter().enumerate() {
        if remaining == 0 {
            break;
        }
        let allowance = MAX_ATTACHMENT_TEXT_UNITS.min(remaining);
        let Some(text) = content(attachment, &root, allowance) else {
            continue;
        };
        remaining = remaining.saturating_sub(text.encode_utf16().count());
        context.push_str("\n\n### Attachment Content: ");
        context.push_str(&name(attachment, index));
        context.push_str("\nAttachment ID: ");
        context.push_str(&attachment.id);
        context.push_str("\n````text\n");
        context.push_str(&text);
        context.push_str("\n````");
    }
    Ok(format!("{}\n\n{context}", request.prompt))
}

fn content(attachment: &AttachmentRef, root: &Path, max_units: usize) -> Option<String> {
    if pdf(attachment) {
        let Some(original) = path(attachment, root) else {
            return Some(
                "[PDF attachment is unavailable; its contents have not been read.]".into(),
            );
        };
        let text_path = PathBuf::from(format!("{}.txt", original.display()));
        return match std::fs::read_to_string(&text_path) {
            Ok(text) => Some(format!(
                "Full extracted text file (use a file-reading command for sections beyond this preview): {}\n{}",
                text_path.display(),
                trim_text(&text, max_units)
            )),
            Err(_) => Some(
                "[PDF text extraction is unavailable; its contents have not been read.]".into(),
            ),
        };
    }
    if !text_attachment(attachment) {
        return None;
    }
    let path = path(attachment, root)?;
    let metadata = std::fs::metadata(&path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_ATTACHMENT_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    let decoded = String::from_utf8_lossy(&bytes).replace('\0', "");
    if crate::public_text::trim_js_whitespace(&decoded).is_empty() {
        None
    } else {
        Some(trim_text(&decoded, max_units))
    }
}

fn path(attachment: &AttachmentRef, root: &Path) -> Option<PathBuf> {
    if message_file_id(&attachment.id) {
        return Some(root.join("app-server/message-files").join(&attachment.id));
    }
    let path = Path::new(attachment.local_path.as_deref()?);
    (path.is_absolute() && path.exists()).then(|| path.to_owned())
}

fn trim_text(text: &str, max_units: usize) -> String {
    let normalized = text.replace("\r\n", "\n");
    let normalized = crate::public_text::trim_js_whitespace(&normalized);
    if normalized.encode_utf16().count() <= max_units {
        return normalized.into();
    }
    let marker = "\n[...attachment content trimmed...]\n";
    let marker_units = marker.encode_utf16().count();
    let head_units = crate::json::saturating_usize(
        ((max_units.saturating_sub(marker_units)) as f64 * 0.65).floor(),
    );
    let tail_units = max_units.saturating_sub(marker_units + head_units);
    let head = utf16_prefix(normalized, head_units);
    let tail = utf16_suffix(normalized, tail_units);
    format!(
        "{}\n{}\n{}",
        crate::public_text::trim_js_whitespace_end(head),
        crate::public_text::trim_js_whitespace(marker),
        crate::public_text::trim_js_whitespace_start(tail)
    )
}

fn utf16_prefix(value: &str, units: usize) -> &str {
    let mut used = 0;
    let end = value
        .char_indices()
        .take_while(|(_, character)| {
            let next = used + character.len_utf16();
            let keep = next <= units;
            if keep {
                used = next;
            }
            keep
        })
        .map(|(index, character)| index + character.len_utf8())
        .last()
        .unwrap_or(0);
    &value[..end]
}

fn utf16_suffix(value: &str, units: usize) -> &str {
    let mut used = 0;
    let start = value
        .char_indices()
        .rev()
        .take_while(|(_, character)| {
            let next = used + character.len_utf16();
            let keep = next <= units;
            if keep {
                used = next;
            }
            keep
        })
        .map(|(index, _)| index)
        .last()
        .unwrap_or(value.len());
    &value[start..]
}

fn data_root(explicit: Option<&str>) -> PathBuf {
    explicit
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("BUTLER_DATA").map(PathBuf::from))
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".butler")))
        .unwrap_or_else(|| PathBuf::from(".butler"))
}

fn message_file_id(value: &str) -> bool {
    value.len() == 41
        && value.starts_with("file-")
        && value[5..]
            .bytes()
            .all(|value| value.is_ascii_hexdigit() || value == b'-')
}

fn text_attachment(attachment: &AttachmentRef) -> bool {
    if attachment.kind == AttachmentKind::Document {
        return true;
    }
    let mime = attachment
        .mime_type
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if mime.starts_with("text/")
        || [
            "application/json",
            "application/ld+json",
            "application/markdown",
            "application/xml",
            "application/yaml",
            "application/x-yaml",
            "application/javascript",
            "application/typescript",
        ]
        .contains(&mime.as_str())
    {
        return true;
    }
    let extension = Path::new(attachment.file_name.as_deref().unwrap_or_default())
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{}", value.to_ascii_lowercase()))
        .unwrap_or_default();
    [
        ".md",
        ".markdown",
        ".txt",
        ".json",
        ".jsonl",
        ".yaml",
        ".yml",
        ".xml",
        ".csv",
        ".tsv",
        ".js",
        ".jsx",
        ".ts",
        ".tsx",
        ".css",
        ".html",
    ]
    .contains(&extension.as_str())
}

fn pdf(attachment: &AttachmentRef) -> bool {
    attachment
        .mime_type
        .as_deref()
        .and_then(|value| value.split(';').next())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("application/pdf"))
        || attachment
            .file_name
            .as_deref()
            .is_some_and(|value| value.to_ascii_lowercase().ends_with(".pdf"))
}

fn name(attachment: &AttachmentRef, index: usize) -> String {
    attachment
        .file_name
        .as_deref()
        .map(crate::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("attachment-{}", index + 1))
}

fn size(value: Option<f64>) -> String {
    value
        .filter(|value| value.is_finite())
        .map(|value| format!("{} bytes", ryu_js::Buffer::new().format(value)))
        .unwrap_or_else(|| "unknown size".into())
}

fn kind(value: &AttachmentKind) -> &'static str {
    match value {
        AttachmentKind::Image => "image",
        AttachmentKind::Audio => "audio",
        AttachmentKind::Video => "video",
        AttachmentKind::Document => "document",
        AttachmentKind::Binary => "binary",
    }
}

fn failure(code: &str, message: &str) -> ModelRoundError {
    ModelRoundError::InvocationFailure {
        code: Some(code.into()),
        message: message.into(),
    }
}

#[cfg(test)]
mod tests;
