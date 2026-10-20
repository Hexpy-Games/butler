//! Source file identity and bounded attachment content reads.

use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use butler_models::models::{
    MAX_INLINE_BYTES, NotInlined, decode_text, is_pdf, is_text, message_file_path,
};
use butler_turn::btcc::{AttachmentKind, AttachmentRef};

use super::clip;

const PDF_MISSING: &str = "[PDF attachment is unavailable; its contents have not been read.]";
const PDF_TEXT_MISSING: &str =
    "[PDF text extraction is unavailable; its contents have not been read.]";

fn lexical_absolute(path: &Path) -> Option<PathBuf> {
    let mut resolved = PathBuf::new();
    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir().ok()?.join(path)
    };
    for component in absolute.components() {
        match component {
            Component::Prefix(prefix) => resolved.push(prefix.as_os_str()),
            Component::RootDir => resolved.push(Path::new("/")),
            Component::CurDir => {}
            Component::ParentDir => {
                resolved.pop();
            }
            Component::Normal(name) => resolved.push(name),
        }
    }
    Some(resolved)
}

pub(super) fn attachment_file_path(
    attachment: &AttachmentRef,
    butler_data: &Path,
) -> Option<PathBuf> {
    if let Some(path) = message_file_path(butler_data, attachment) {
        return Some(path);
    }
    let local = Path::new(attachment.local_path.as_deref()?);
    if !local.is_absolute() {
        return None;
    }
    let resolved = lexical_absolute(local)?;
    resolved.exists().then_some(resolved)
}

pub(super) enum Content {
    Inline(String),
    NotInlined(NotInlined),
    Skip,
}

fn read_attachment_bytes(
    attachment: &AttachmentRef,
    butler_data: &Path,
) -> Result<Vec<u8>, NotInlined> {
    let path = attachment_file_path(attachment, butler_data).ok_or(NotInlined::Unreadable)?;
    let metadata = fs::metadata(&path).map_err(|_| NotInlined::Unreadable)?;
    if !metadata.is_file() {
        return Err(NotInlined::Unreadable);
    }
    if metadata.len() > MAX_INLINE_BYTES {
        return Err(NotInlined::TooLarge);
    }
    let capacity = usize::try_from(metadata.len()).map_err(|_| NotInlined::TooLarge)?;
    let mut bytes = Vec::with_capacity(capacity);
    File::open(path)
        .and_then(|f| f.take(MAX_INLINE_BYTES + 1).read_to_end(&mut bytes))
        .map_err(|_| NotInlined::Unreadable)?;
    if bytes.len() as u64 > MAX_INLINE_BYTES {
        return Err(NotInlined::TooLarge);
    }
    Ok(bytes)
}

pub(super) fn attachment_content(
    attachment: &AttachmentRef,
    butler_data: &Path,
    max_chars: usize,
) -> Content {
    // VerifiedImagePayloadPort alone may read original image bytes.
    if attachment.kind == AttachmentKind::Image {
        return Content::Skip;
    }
    if is_pdf(attachment) {
        let Some(original) = attachment_file_path(attachment, butler_data) else {
            return Content::Inline(PDF_MISSING.into());
        };
        let sidecar = PathBuf::from(format!("{}.txt", original.display()));
        return Content::Inline(
            match File::open(&sidecar).and_then(|file| clip::from_reader(file, max_chars)) {
                Ok(preview) => format!(
                    "Full extracted text file (use a file-reading command for sections beyond this preview): {}\n{}",
                    sidecar.display(),
                    preview.unwrap_or_default()
                ),
                Err(_) => PDF_TEXT_MISSING.into(),
            },
        );
    }
    if !is_text(attachment) {
        return Content::NotInlined(NotInlined::Format);
    }
    match read_attachment_bytes(attachment, butler_data) {
        Ok(bytes) => clip::from_text(&decode_text(&bytes), max_chars)
            .map(Content::Inline)
            .unwrap_or(Content::Skip),
        Err(reason) => Content::NotInlined(reason),
    }
}
