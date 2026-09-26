//! Provider-time derivative read; no retained image byte cache.

use serde_json::Value;

use super::{GatewayApplicationError, NativeAppImageFiles, files};
use crate::public_text::trim_js_whitespace;
use crate::{
    btcc::{BtccError, PortFuture, VerifiedImagePayloadPort},
    context::VisualAttachmentManifest,
};

impl VerifiedImagePayloadPort for NativeAppImageFiles {
    fn read<'a>(&'a self, reference: &'a Value) -> PortFuture<'a, Vec<u8>> {
        Box::pin(async move {
            let manifest: VisualAttachmentManifest = serde_json::from_value(reference.clone())
                .map_err(|_| {
                    BtccError::relayed("image_payload_invalid", "file_identity_invalid")
                })?;
            let file_id = trim_js_whitespace(&manifest.file_id);
            if !valid_file_id(file_id) || !valid_digest(&manifest.derivative_digest) {
                return Err(BtccError::relayed(
                    "image_payload_invalid",
                    "file_identity_invalid",
                ));
            }
            let root = self.root.clone();
            self.run(move || files::provider_derivative(&root, &manifest))
                .await
                .map_err(|error| match error {
                    GatewayApplicationError::Public { code, message, .. } => {
                        BtccError::relayed(code, message)
                    }
                    GatewayApplicationError::Internal => {
                        BtccError::relayed("image_payload_invalid", "derivative_missing")
                    }
                })
        })
    }
}

fn valid_file_id(value: &str) -> bool {
    value.len() == 41
        && value
            .get(..5)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("file-"))
        && value[5..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
