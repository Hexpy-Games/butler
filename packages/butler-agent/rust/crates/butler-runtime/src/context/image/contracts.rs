pub use butler_models::models::VisualAttachmentManifest;

/// Optional caller limits retain JavaScript number comparison semantics.
#[derive(Clone, Copy, Debug, Default)]
pub struct ImageSanitizerLimits {
    pub(crate) max_bytes: Option<f64>,
    pub(crate) max_width: Option<f64>,
    pub(crate) max_height: Option<f64>,
    pub(crate) max_pixels: Option<f64>,
}

#[derive(Clone, Copy)]
pub struct ImageSanitizerInput<'a> {
    pub file_id: &'a str,
    pub safe_name: &'a str,
    pub mime_type: &'a str,
    pub source_bytes: &'a [u8],
    pub storage_revision: &'a str,
    pub position: usize,
    pub limits: ImageSanitizerLimits,
}

pub struct ImageSourceRecord<'a> {
    pub size_bytes: usize,
    pub sha256: &'a str,
    pub storage_revision: &'a str,
}

pub struct SanitizedImage {
    pub manifest: VisualAttachmentManifest,
    pub bytes: Vec<u8>,
}
