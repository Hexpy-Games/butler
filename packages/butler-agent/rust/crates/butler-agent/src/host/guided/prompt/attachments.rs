//! Source attachment identity projection; bytes stay with the late payload owner.

use butler_turn::btcc::{AttachmentRef, BtccError, TurnRecord};
use serde_json::Value;

pub(super) fn source_refs(turn: &TurnRecord) -> Result<Vec<AttachmentRef>, BtccError> {
    match turn
        .context
        .get("attachments")
        .filter(|value| !value.is_null())
    {
        Some(value) => serde_json::from_value(value.clone()).map_err(|error| {
            BtccError::relayed("guided_attachment_invalid", error.to_string()).with_source(error)
        }),
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

/// The editor selection belongs to the current user message, after its text.
pub(super) fn editor_note(turn: &TurnRecord) -> String {
    let Some(edit) = turn.context.pointer("/messageContent/image_edit") else {
        return String::new();
    };
    let Some(image) = edit["image"].as_str() else {
        return String::new();
    };
    let mask = edit["mask"]
        .as_str()
        .map(|m| format!(" · mask {m}"))
        .unwrap_or_default();
    format!("\n[Image editor: image {image}{mask}]")
}
