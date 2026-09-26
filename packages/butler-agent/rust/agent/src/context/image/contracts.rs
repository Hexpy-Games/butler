pub(crate) use crate::models::VisualAttachmentManifest;

/// Optional caller limits retain JavaScript number comparison semantics.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct ImageSanitizerLimits {
    pub(crate) max_bytes: Option<f64>,
    pub(crate) max_width: Option<f64>,
    pub(crate) max_height: Option<f64>,
    pub(crate) max_pixels: Option<f64>,
}

#[derive(Clone, Copy)]
pub(crate) struct ImageSanitizerInput<'a> {
    pub(crate) file_id: &'a str,
    pub(crate) safe_name: &'a str,
    pub(crate) mime_type: &'a str,
    pub(crate) source_bytes: &'a [u8],
    pub(crate) storage_revision: &'a str,
    pub(crate) position: usize,
    pub(crate) limits: ImageSanitizerLimits,
}

pub(crate) struct ImageSourceRecord<'a> {
    pub(crate) size_bytes: usize,
    pub(crate) sha256: &'a str,
    pub(crate) storage_revision: &'a str,
}

pub(crate) struct SanitizedImage {
    pub(crate) manifest: VisualAttachmentManifest,
    pub(crate) bytes: Vec<u8>,
}
