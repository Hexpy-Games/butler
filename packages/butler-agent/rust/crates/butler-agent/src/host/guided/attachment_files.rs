//! Turn-scoped file-read authority derives solely from admitted message-file IDs.
use butler_models::models::{is_pdf, message_file_path};
use butler_turn::btcc::{AttachmentKind, AttachmentRef};
use std::path::{Path, PathBuf};

pub(super) fn from_context(context: &serde_json::Value, data: &Path) -> Vec<PathBuf> {
    let attachments: Vec<AttachmentRef> = context
        .get("attachments")
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default();
    let mut paths = Vec::new();
    for attachment in attachments {
        if attachment.kind == AttachmentKind::Image {
            continue;
        }
        let Some(path) = message_file_path(data, &attachment.id) else {
            continue;
        };
        if is_pdf(&attachment) {
            let mut sidecar = path.as_os_str().to_os_string();
            sidecar.push(".txt");
            paths.push(PathBuf::from(sidecar));
        }
        paths.push(path);
    }
    paths
}
