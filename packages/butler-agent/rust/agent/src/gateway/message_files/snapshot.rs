//! Exact project source snapshots; database ownership stays with AppApplication.

use std::{fs, path::Path};

use sha2::{Digest, Sha256};

use super::names;
use crate::gateway::{AppIdentityClock, GatewayApplicationError, MaterializedResponderFile};

pub(super) fn write(
    root: &Path,
    clock: &dyn AppIdentityClock,
    name: &str,
    body: &str,
) -> Result<MaterializedResponderFile, GatewayApplicationError> {
    if body.is_empty() {
        return Err(public(
            400,
            "message_file_empty",
            "Attachment file is empty.",
        ));
    }
    if body.len() > 10 * 1024 * 1024 {
        return Err(public(
            413,
            "message_file_too_large",
            "Attachment file is too large.",
        ));
    }
    let id = format!("file-{}", clock.new_uuid());
    if id.len() != 41
        || !id[5..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
    {
        return Err(GatewayApplicationError::Internal);
    }
    let file = MaterializedResponderFile {
        id: id.clone(),
        kind: "text".into(),
        mime_type: "text/markdown".into(),
        safe_name: names::safe_name(name).stored,
        size_bytes: body.len() as u64,
        sha256: format!("{:x}", Sha256::digest(body.as_bytes())),
        storage_name: id.clone(),
        created_at: clock.now_iso(),
    };
    fs::create_dir_all(root).map_err(|_| GatewayApplicationError::Internal)?;
    fs::write(root.join(id), body.as_bytes()).map_err(|_| GatewayApplicationError::Internal)?;
    Ok(file)
}

fn public(status: u16, code: &str, message: &str) -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status,
        code: code.into(),
        message: message.into(),
    }
}
