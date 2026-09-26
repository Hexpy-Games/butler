use serde::Serialize;
use sha2::{Digest, Sha256};

use super::contracts::{ImageSanitizerInput, ImageSourceRecord, VisualAttachmentManifest};
use crate::context::{ContextError, ContextResult};
use crate::public_text::trim_js_whitespace;

pub(super) const SANITIZER_REVISION: &str = "visual-derivative-rust-v1";

#[derive(Clone, Copy)]
pub(super) struct SniffedImage {
    pub(super) mime_type: &'static str,
    pub(super) magic: &'static str,
}

pub(super) fn sniff_image(bytes: &[u8]) -> Option<SniffedImage> {
    let (mime_type, magic) = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        ("image/png", "png")
    } else if bytes.starts_with(b"\xff\xd8") {
        ("image/jpeg", "jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        ("image/gif", "gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        ("image/webp", "webp")
    } else {
        return None;
    };
    Some(SniffedImage { mime_type, magic })
}

pub(super) fn assert_magic(mime_type: &str, bytes: &[u8]) -> ContextResult<SniffedImage> {
    let sniffed = sniff_image(bytes)
        .ok_or_else(|| ContextError::new("image_manifest_invalid", "magic_unrecognized"))?;
    if sniffed.mime_type != mime_type.to_lowercase() {
        return Err(ContextError::new(
            "image_manifest_invalid",
            "magic_mime_mismatch",
        ));
    }
    Ok(sniffed)
}

pub(super) fn create_visual_manifest(
    input: &ImageSanitizerInput<'_>,
    derivative_bytes: &[u8],
    derivative_mime_type: &str,
    width: u32,
    height: u32,
) -> ContextResult<VisualAttachmentManifest> {
    if input.source_bytes.is_empty() || derivative_bytes.is_empty() {
        return Err(ContextError::new("image_manifest_invalid", "empty_payload"));
    }
    let sniffed = assert_magic(input.mime_type, input.source_bytes)?;
    let derivative_sniffed = assert_magic(derivative_mime_type, derivative_bytes)?;
    if width == 0 || height == 0 {
        return Err(ContextError::new(
            "image_manifest_invalid",
            "dimensions_unavailable",
        ));
    }
    let source_digest = format!("{:x}", Sha256::digest(input.source_bytes));
    let derivative_digest = format!("{:x}", Sha256::digest(derivative_bytes));
    let storage_revision = trim_js_whitespace(input.storage_revision);
    let storage_revision = if storage_revision.is_empty() {
        "message-file-row-v1"
    } else {
        storage_revision
    };
    let mut manifest = VisualAttachmentManifest {
        kind: "image".to_owned(),
        file_id: input.file_id.to_owned(),
        position: input.position,
        safe_name: input.safe_name.to_owned(),
        mime_type: sniffed.mime_type.to_owned(),
        sniffed_mime_type: sniffed.mime_type.to_owned(),
        sniffed_magic: sniffed.magic.to_owned(),
        storage_revision: storage_revision.to_owned(),
        source_size_bytes: input.source_bytes.len(),
        source_digest,
        derivative_id: format!(
            "{}:visual:{SANITIZER_REVISION}:{derivative_digest}",
            input.file_id
        ),
        derivative_mime_type: derivative_sniffed.mime_type.to_owned(),
        derivative_size_bytes: derivative_bytes.len(),
        derivative_digest,
        width,
        height,
        pixel_count: u64::from(width) * u64::from(height),
        sanitizer_revision: SANITIZER_REVISION.to_owned(),
        manifest_digest: String::new(),
    };
    manifest.manifest_digest = manifest_digest(&manifest)?;
    Ok(manifest)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ManifestDigestInput<'a> {
    kind: &'a str,
    file_id: &'a str,
    position: usize,
    safe_name: &'a str,
    mime_type: &'a str,
    sniffed_mime_type: &'a str,
    sniffed_magic: &'a str,
    storage_revision: &'a str,
    source_size_bytes: usize,
    source_digest: &'a str,
    derivative_id: &'a str,
    derivative_mime_type: &'a str,
    derivative_size_bytes: usize,
    derivative_digest: &'a str,
    width: u32,
    height: u32,
    pixel_count: u64,
    sanitizer_revision: &'a str,
}

fn manifest_digest(manifest: &VisualAttachmentManifest) -> ContextResult<String> {
    let digest_input = ManifestDigestInput {
        kind: &manifest.kind,
        file_id: &manifest.file_id,
        position: manifest.position,
        safe_name: &manifest.safe_name,
        mime_type: &manifest.mime_type,
        sniffed_mime_type: &manifest.sniffed_mime_type,
        sniffed_magic: &manifest.sniffed_magic,
        storage_revision: &manifest.storage_revision,
        source_size_bytes: manifest.source_size_bytes,
        source_digest: &manifest.source_digest,
        derivative_id: &manifest.derivative_id,
        derivative_mime_type: &manifest.derivative_mime_type,
        derivative_size_bytes: manifest.derivative_size_bytes,
        derivative_digest: &manifest.derivative_digest,
        width: manifest.width,
        height: manifest.height,
        pixel_count: manifest.pixel_count,
        sanitizer_revision: &manifest.sanitizer_revision,
    };
    let encoded = serde_json::to_vec(&digest_input)
        .map_err(|error| ContextError::new("image_manifest_invalid", error.to_string()))?;
    Ok(format!("{:x}", Sha256::digest(encoded)))
}

/// Match source record binding without requiring the current sanitizer revision.
pub(crate) fn verify_visual_manifest_source(
    manifest: &VisualAttachmentManifest,
    source_bytes: &[u8],
    source_record: &ImageSourceRecord<'_>,
) -> ContextResult<()> {
    let source_digest = format!("{:x}", Sha256::digest(source_bytes));
    if source_bytes.len() != source_record.size_bytes
        || source_bytes.len() != manifest.source_size_bytes
        || source_digest != source_record.sha256
        || source_digest != manifest.source_digest
        || source_record.storage_revision != manifest.storage_revision
    {
        return Err(ContextError::new(
            "image_payload_invalid",
            "source_record_mismatch",
        ));
    }
    let sniffed = sniff_image(source_bytes);
    if !sniffed.is_some_and(|sniffed| {
        sniffed.mime_type == manifest.sniffed_mime_type && sniffed.magic == manifest.sniffed_magic
    }) {
        return Err(ContextError::new(
            "image_payload_invalid",
            "source_magic_mismatch",
        ));
    }
    Ok(())
}
