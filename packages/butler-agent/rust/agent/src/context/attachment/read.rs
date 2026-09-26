//! Source file identity and bounded attachment content reads.

use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use crate::btcc::{AttachmentKind, AttachmentRef};
use crate::public_text::trim_js_whitespace;

use super::clip;

const MAX_ATTACHMENT_BYTES_TO_READ: u64 = 512_000;
const PDF_MISSING: &str = "[PDF attachment is unavailable; its contents have not been read.]";
const PDF_TEXT_MISSING: &str =
    "[PDF text extraction is unavailable; its contents have not been read.]";

fn message_file_id(id: &str) -> bool {
    let Some((prefix, suffix)) = id.get(..5).zip(id.get(5..)) else {
        return false;
    };
    prefix.eq_ignore_ascii_case("file-")
        && suffix.len() == 36
        && suffix
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
}

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

fn attachment_file_path(attachment: &AttachmentRef, butler_data: &Path) -> Option<PathBuf> {
    if message_file_id(&attachment.id) {
        return Some(
            butler_data
                .join("app-server/message-files")
                .join(&attachment.id),
        );
    }
    let local = Path::new(attachment.local_path.as_deref()?);
    if !local.is_absolute() {
        return None;
    }
    let resolved = lexical_absolute(local)?;
    resolved.exists().then_some(resolved)
}

fn is_pdf(attachment: &AttachmentRef) -> bool {
    attachment.mime_type.as_deref().is_some_and(|mime| {
        trim_js_whitespace(mime.split(';').next().unwrap_or_default()).to_lowercase()
            == "application/pdf"
    }) || attachment
        .file_name
        .as_deref()
        .is_some_and(|name| name.to_lowercase().ends_with(".pdf"))
}

fn is_text(attachment: &AttachmentRef) -> bool {
    if attachment.kind == AttachmentKind::Document {
        return true;
    }
    let mime = attachment
        .mime_type
        .as_deref()
        .unwrap_or_default()
        .to_lowercase();
    if mime.starts_with("text/")
        || matches!(
            mime.as_str(),
            "application/json"
                | "application/ld+json"
                | "application/markdown"
                | "application/xml"
                | "application/yaml"
                | "application/x-yaml"
                | "application/javascript"
                | "application/typescript"
        )
    {
        return true;
    }
    let name = attachment.file_name.as_deref().unwrap_or_default();
    let name = name.rsplit('/').next().unwrap_or(name);
    let extension = name
        .rfind('.')
        .filter(|index| *index > 0)
        .map(|index| &name[index..])
        .unwrap_or_default()
        .to_lowercase();
    matches!(
        extension.as_str(),
        ".md"
            | ".markdown"
            | ".txt"
            | ".json"
            | ".jsonl"
            | ".yaml"
            | ".yml"
            | ".xml"
            | ".csv"
            | ".tsv"
            | ".js"
            | ".jsx"
            | ".ts"
            | ".tsx"
            | ".css"
            | ".html"
    )
}

fn read_attachment_bytes(attachment: &AttachmentRef, butler_data: &Path) -> Option<Vec<u8>> {
    let path = attachment_file_path(attachment, butler_data)?;
    if message_file_id(&attachment.id) {
        let root = lexical_absolute(&butler_data.join("app-server/message-files"))?;
        let resolved = lexical_absolute(&path)?;
        if !resolved.starts_with(&root) || resolved == root {
            return None;
        }
    }
    let metadata = fs::metadata(&path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_ATTACHMENT_BYTES_TO_READ {
        return None;
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(path)
        .ok()?
        .take(MAX_ATTACHMENT_BYTES_TO_READ + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() <= MAX_ATTACHMENT_BYTES_TO_READ as usize).then_some(bytes)
}

pub(super) fn attachment_content(
    attachment: &AttachmentRef,
    butler_data: &Path,
    max_chars: usize,
) -> Option<String> {
    // VerifiedImagePayloadPort alone may read original image bytes.
    if attachment.kind == AttachmentKind::Image {
        return None;
    }
    if is_pdf(attachment) {
        let Some(original) = attachment_file_path(attachment, butler_data) else {
            return Some(PDF_MISSING.into());
        };
        let sidecar = PathBuf::from(format!("{}.txt", original.display()));
        return Some(
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
        return None;
    }
    let bytes = read_attachment_bytes(attachment, butler_data)?;
    let text = String::from_utf8_lossy(&bytes);
    let without_nul = text.replace('\0', "");
    clip::from_text(&without_nul, max_chars)
}
