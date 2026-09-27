//! Shared path-free image identity used by Context, App and provider serialization.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualAttachmentManifest {
    pub kind: String,
    pub file_id: String,
    pub position: usize,
    pub safe_name: String,
    pub mime_type: String,
    pub sniffed_mime_type: String,
    pub sniffed_magic: String,
    pub storage_revision: String,
    pub source_size_bytes: usize,
    pub source_digest: String,
    pub derivative_id: String,
    pub derivative_mime_type: String,
    pub derivative_size_bytes: usize,
    pub derivative_digest: String,
    pub width: u32,
    pub height: u32,
    pub pixel_count: u64,
    pub sanitizer_revision: String,
    pub manifest_digest: String,
}
