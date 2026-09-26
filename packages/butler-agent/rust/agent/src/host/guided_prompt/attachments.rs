//! Source attachment identity projection; bytes stay with the late payload owner.

use crate::btcc::{AttachmentRef, BtccError, TurnRecord};
use serde_json::Value;

pub(super) fn source_refs(turn: &TurnRecord) -> Result<Vec<AttachmentRef>, BtccError> {
    match turn
        .context
        .get("attachments")
        .filter(|value| !value.is_null())
    {
        Some(value) => serde_json::from_value(value.clone())
            .map_err(|error| BtccError::new("guided_attachment_invalid", error.to_string())),
        None => Ok(Vec::new()),
    }
}

pub(super) fn provider_images(turn: &TurnRecord) -> Vec<Value> {
    let admitted = turn
        .context
        .pointer("/imageAdmission/manifests")
        .and_then(Value::as_array);
    turn.context
        .get("attachments")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| item.get("kind").and_then(Value::as_str) == Some("image"))
        .map(|item| {
            let mut attachment = item.clone();
            let manifest = item
                .get("visualManifest")
                .filter(|value| !value.is_null())
                .or_else(|| {
                    admitted
                        .into_iter()
                        .flatten()
                        .rev()
                        .find(|manifest| manifest.get("fileId") == item.get("id"))
                });
            if let Some(manifest) = manifest {
                attachment["visualManifest"] = manifest.clone();
                if let Some(id) = manifest.get("fileId").filter(|value| !value.is_null()) {
                    attachment["id"] = id.clone();
                }
            }
            attachment
        })
        .collect()
}
