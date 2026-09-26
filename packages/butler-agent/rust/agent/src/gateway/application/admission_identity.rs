//! Stable public message identity and exact immutable admission digest.

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::{AppIdentityClock, GatewayApplicationError, MessageContent, PreparedAppAdmission};
use crate::gateway::MessageSendRequest;
use crate::public_text::trim_js_whitespace;

pub(super) fn stable_client_id(
    value: Option<&Value>,
    clock: &dyn AppIdentityClock,
) -> Result<String, GatewayApplicationError> {
    let trimmed = value
        .and_then(Value::as_str)
        .map(trim_js_whitespace)
        .filter(|value| !value.is_empty());
    let Some(value) = trimmed else {
        return Ok(format!("client-{}", clock.new_uuid()));
    };
    if valid_client_uuid(value) {
        return Ok(value.to_ascii_lowercase());
    }
    let hash = format!("{:x}", Sha256::digest(value.as_bytes()));
    Ok(format!(
        "client-{}-{}-4{}-8{}-{}",
        &hash[..8],
        &hash[8..12],
        &hash[13..16],
        &hash[17..20],
        &hash[20..32]
    ))
}

fn valid_client_uuid(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    lower.len() == 43
        && lower.starts_with("client-")
        && [15, 20, 25, 30]
            .into_iter()
            .all(|index| bytes[index] == b'-')
        && bytes[7..].iter().enumerate().all(|(index, byte)| {
            [8, 13, 18, 23].contains(&index)
                || byte.is_ascii_digit()
                || (b'a'..=b'f').contains(byte)
        })
}
pub(super) fn input_digest(
    request: &MessageSendRequest,
    prepared: &PreparedAppAdmission,
) -> Result<String, GatewayApplicationError> {
    input_digest_with_plan(request, prepared, None)
}

pub(super) fn input_digest_with_plan(
    request: &MessageSendRequest,
    prepared: &PreparedAppAdmission,
    plan_id: Option<&str>,
) -> Result<String, GatewayApplicationError> {
    let requested_ids = request
        .attachments
        .as_ref()
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|item| {
            item.get("file_id")
                .and_then(Value::as_str)
                .map_or("", trim_js_whitespace)
                .to_owned()
        })
        .collect::<Vec<_>>();
    let mut object = serde_json::Map::new();
    object.insert(
        "version".into(),
        Value::from(if requested_ids.is_empty() { 1 } else { 2 }),
    );
    object.insert("text".into(), prepared.text.clone().into());
    if let Some(content) = request.content_parts.as_ref() {
        object.insert(
            "content_parts".into(),
            serde_json::to_value(content).map_err(|_| GatewayApplicationError::Internal)?,
        );
    }
    if let Some(project) = request.expected_project_id.as_ref() {
        object.insert("expected_project_id".into(), project.clone().into());
    }
    object.insert("explicit_controls".into(),json!({"model":request.model,"reasoning_effort":request.reasoning_effort,
        "access_mode":request.access_mode,"plan_mode":request.plan_mode,"plan_id":plan_id,"authority_request_ref":null}));
    object.insert(
        "admission_identity".into(),
        prepared.admission_identity.clone(),
    );
    if !requested_ids.is_empty() {
        object.insert(
            "requested_attachment_ids".into(),
            serde_json::to_value(requested_ids).map_err(|_| GatewayApplicationError::Internal)?,
        );
    }
    let value = Value::Object(object);
    Ok(format!(
        "{:x}",
        Sha256::digest(stringify(&value)?.as_bytes())
    ))
}
pub(super) fn serialize_optional(
    value: Option<&MessageContent>,
) -> Result<Option<String>, GatewayApplicationError> {
    value.map(stringify).transpose()
}
pub(super) fn stringify(value: &impl serde::Serialize) -> Result<String, GatewayApplicationError> {
    serde_json::to_string(value).map_err(|_| GatewayApplicationError::Internal)
}
