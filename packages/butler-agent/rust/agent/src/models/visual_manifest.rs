//! Shared path-free image identity used by Context, App and provider serialization.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VisualAttachmentManifest {
    pub(crate) kind: String,
    pub(crate) file_id: String,
    pub(crate) position: usize,
    pub(crate) safe_name: String,
    pub(crate) mime_type: String,
    pub(crate) sniffed_mime_type: String,
    pub(crate) sniffed_magic: String,
    pub(crate) storage_revision: String,
    pub(crate) source_size_bytes: usize,
    pub(crate) source_digest: String,
    pub(crate) derivative_id: String,
    pub(crate) derivative_mime_type: String,
    pub(crate) derivative_size_bytes: usize,
    pub(crate) derivative_digest: String,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) pixel_count: u64,
    pub(crate) sanitizer_revision: String,
    pub(crate) manifest_digest: String,
}
