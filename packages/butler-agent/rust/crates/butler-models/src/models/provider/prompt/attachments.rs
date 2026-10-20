use std::path::{Path, PathBuf};

use crate::models::{
    MAX_INLINE_BYTES, NotInlined, ProviderPromptRequest, decode_text, display_name, is_pdf,
    is_text, listing_line, message_file_path, not_inlined_block,
};
use butler_turn::btcc::{AttachmentKind, AttachmentRef, ModelRoundError};

const MAX_ATTACHMENT_TEXT_UNITS: usize = 24_000;
const MAX_TOTAL_TEXT_UNITS: usize = 60_000;
enum Content {
    Inline(String),
    NotInlined(NotInlined),
    Skip,
}

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
        let path = path(attachment, &root);
        context.push('\n');
        context.push_str(&listing_line(attachment, index, path.as_deref()));
    }
    let mut remaining = MAX_TOTAL_TEXT_UNITS;
    for (index, attachment) in attachments.iter().enumerate() {
        let content = if remaining == 0 {
            Content::NotInlined(NotInlined::Budget)
        } else {
            content(attachment, &root, MAX_ATTACHMENT_TEXT_UNITS.min(remaining))
        };
        match content {
            Content::Inline(text) => {
                remaining = remaining.saturating_sub(text.encode_utf16().count());
                context.push_str(&format!(
                    "\n\n### Attachment Content: {}\nAttachment ID: {}\n````text\n{text}\n````",
                    display_name(attachment, index),
                    attachment.id
                ));
            }
            Content::NotInlined(reason) => {
                let path = path(attachment, &root);
                context.push_str("\n\n");
                context.push_str(&not_inlined_block(
                    attachment,
                    index,
                    path.as_deref(),
                    reason,
                ));
            }
            Content::Skip => {}
        }
    }
    Ok(format!("{}\n\n{context}", request.prompt))
}

fn content(attachment: &AttachmentRef, root: &Path, max_units: usize) -> Content {
    if attachment.kind == AttachmentKind::Image {
        return Content::Skip;
    }
    if is_pdf(attachment) {
        let Some(original) = path(attachment, root) else {
            return Content::Inline(
                "[PDF attachment is unavailable; its contents have not been read.]".into(),
            );
        };
        let text_path = PathBuf::from(format!("{}.txt", original.display()));
        return Content::Inline(match std::fs::read_to_string(&text_path) {
            Ok(text) => format!(
                "Full extracted text file (use a file-reading command for sections beyond this preview): {}\n{}",
                text_path.display(),
                trim_text(&text, max_units)
            ),
            Err(_) => {
                "[PDF text extraction is unavailable; its contents have not been read.]".into()
            }
        });
    }
    if !is_text(attachment) {
        return Content::NotInlined(NotInlined::Format);
    }
    match read_text(attachment, root) {
        Ok(bytes) => {
            let text = decode_text(&bytes);
            if butler_core::public_text::trim_js_whitespace(&text).is_empty() {
                Content::Skip
            } else {
                Content::Inline(trim_text(&text, max_units))
            }
        }
        Err(reason) => Content::NotInlined(reason),
    }
}
fn read_text(a: &AttachmentRef, root: &Path) -> Result<Vec<u8>, NotInlined> {
    use std::io::Read;
    let path = path(a, root).ok_or(NotInlined::Unreadable)?;
    let metadata = std::fs::metadata(&path).map_err(|_| NotInlined::Unreadable)?;
    if !metadata.is_file() {
        return Err(NotInlined::Unreadable);
    }
    if metadata.len() > MAX_INLINE_BYTES {
        return Err(NotInlined::TooLarge);
    }
    let capacity = usize::try_from(metadata.len()).map_err(|_| NotInlined::TooLarge)?;
    let mut bytes = Vec::with_capacity(capacity);
    std::fs::File::open(path)
        .and_then(|f| f.take(MAX_INLINE_BYTES + 1).read_to_end(&mut bytes))
        .map_err(|_| NotInlined::Unreadable)?;
    if bytes.len() as u64 > MAX_INLINE_BYTES {
        return Err(NotInlined::TooLarge);
    }
    Ok(bytes)
}

fn path(attachment: &AttachmentRef, root: &Path) -> Option<PathBuf> {
    if let Some(path) = message_file_path(root, attachment) {
        return Some(path);
    }
    let path = Path::new(attachment.local_path.as_deref()?);
    (path.is_absolute() && path.exists()).then(|| path.to_owned())
}

fn trim_text(text: &str, max_units: usize) -> String {
    let normalized = text.replace("\r\n", "\n");
    let normalized = butler_core::public_text::trim_js_whitespace(&normalized);
    if normalized.encode_utf16().count() <= max_units {
        return normalized.into();
    }
    let marker = "\n[...attachment content trimmed...]\n";
    let marker_units = marker.encode_utf16().count();
    let head_units = butler_core::json::saturating_usize(
        ((max_units.saturating_sub(marker_units)) as f64 * 0.65).floor(),
    );
    let tail_units = max_units.saturating_sub(marker_units + head_units);
    let head = utf16_prefix(normalized, head_units);
    let tail = utf16_suffix(normalized, tail_units);
    format!(
        "{}\n{}\n{}",
        butler_core::public_text::trim_js_whitespace_end(head),
        butler_core::public_text::trim_js_whitespace(marker),
        butler_core::public_text::trim_js_whitespace_start(tail)
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
        .or_else(|| butler_platform::user_dirs::home_dir().map(|home| home.join(".butler")))
        .unwrap_or_else(|| PathBuf::from(".butler"))
}

fn failure(code: &str, message: &str) -> ModelRoundError {
    ModelRoundError::InvocationFailure {
        code: Some(code.into()),
        message: message.into(),
    }
}

#[cfg(test)]
mod tests;
