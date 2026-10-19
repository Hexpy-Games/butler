//! Admission of an ordinary small image by catalog image models.

use super::*;
use crate::models::{VisualAttachmentManifest, image_admission_for_catalog_entry};

/// A 64x64 PNG derivative well inside every provider's published limits.
fn small_png_manifest() -> VisualAttachmentManifest {
    VisualAttachmentManifest {
        kind: "image".into(),
        file_id: "file-small".into(),
        position: 0,
        safe_name: "small.png".into(),
        mime_type: "image/png".into(),
        sniffed_mime_type: "image/png".into(),
        sniffed_magic: "png".into(),
        storage_revision: "storage-1".into(),
        source_size_bytes: 2_048,
        source_digest: "a".repeat(64),
        derivative_id: "derivative-small".into(),
        derivative_mime_type: "image/png".into(),
        derivative_size_bytes: 2_048,
        derivative_digest: "b".repeat(64),
        width: 64,
        height: 64,
        pixel_count: 64 * 64,
        sanitizer_revision: "sanitizer-1".into(),
        manifest_digest: "c".repeat(64),
    }
}

/// A runnable model that claims image input must admit an ordinary image;
/// limits the provider does not publish never refuse it.
pub(super) fn assert_admits_small_png(model: &ModelProviderMetadata) {
    if !model.runtime_supported {
        return;
    }
    let admitted =
        image_admission_for_catalog_entry(Some(model), std::slice::from_ref(&small_png_manifest()));
    assert!(
        admitted.is_ok(),
        "{}: {:?}",
        model.model_ref,
        admitted.err()
    );
}
