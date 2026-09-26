//! Source-order admission and durable queue admission verification.

use std::path::Path;

use serde_json::{Value, json};

use crate::context::{
    ImageSanitizerInput, ImageSanitizerLimits, ImageSourceRecord, VisualImageAdmissionResult,
    admit_visual_image_request, assert_visual_carrier_matches_catalog,
    image_admission_for_catalog_entry, sanitize_image, verify_visual_manifest_source,
};
use crate::models::{HostedApiShape, ModelProviderMetadata};

use super::files::{self, Stage};
use super::{AppMessageFileSnapshot, GatewayApplicationError, image_error, public};

pub(super) fn admit(
    root: &Path,
    files: &[AppMessageFileSnapshot],
    entry: Option<&ModelProviderMetadata>,
) -> Result<Value, GatewayApplicationError> {
    let mut stages = Vec::new();
    for (position, file) in files.iter().filter(|file| file.kind == "image").enumerate() {
        let source = files::source(root, file)?;
        let revision = format!("{}:{}", file.created_at, file.sha256);
        let sanitized = sanitize_image(ImageSanitizerInput {
            file_id: &file.id,
            safe_name: &file.safe_name,
            mime_type: &file.mime_type,
            source_bytes: &source,
            storage_revision: &revision,
            position,
            limits: ImageSanitizerLimits::default(),
        })
        .map_err(|error| image_error(error.code))?;
        verify_visual_manifest_source(
            &sanitized.manifest,
            &source,
            &ImageSourceRecord {
                size_bytes: usize::try_from(file.size_bytes).unwrap_or(usize::MAX),
                sha256: &file.sha256,
                storage_revision: &revision,
            },
        )
        .map_err(|error| image_error(error.code))?;
        stages.push(Stage::write(root, sanitized.manifest, &sanitized.bytes)?);
    }
    let manifests: Vec<_> = stages.iter().map(|stage| stage.manifest.clone()).collect();
    let admitted = image_admission_for_catalog_entry(entry, &manifests)
        .map_err(|error| image_error(error.code))?;
    for stage in &mut stages {
        stage.publish(root)?;
    }
    let attachments = files
        .iter()
        .map(|file| {
            admitted
                .manifests
                .iter()
                .find(|manifest| manifest.file_id == file.id)
                .map(|manifest| {
                    json!({
                        "file_id": file.id,
                        "image_admission": {
                            "tuple": admitted.tuple,
                            "capability": admitted.capability,
                            "manifests": [manifest],
                        }
                    })
                })
                .unwrap_or_else(|| Value::String(file.id.clone()))
        })
        .collect();
    Ok(Value::Array(attachments))
}

pub(super) fn parse_queued(
    attachments: &Value,
) -> Result<Option<VisualImageAdmissionResult>, GatewayApplicationError> {
    let Some(attachments) = attachments.as_array() else {
        return Ok(None);
    };
    let mut parsed: Option<VisualImageAdmissionResult> = None;
    for item in attachments {
        let Some(object) = item.as_object() else {
            continue;
        };
        if !object.contains_key("file_id") {
            continue;
        }
        let Some(raw) = object.get("image_admission") else {
            return Err(invalid_queue());
        };
        let current: VisualImageAdmissionResult =
            serde_json::from_value(raw.clone()).map_err(|_| invalid_queue())?;
        if let Some(first) = &mut parsed {
            if first.tuple != current.tuple || first.capability != current.capability {
                return Err(invalid_queue());
            }
            first.manifests.extend(current.manifests);
        } else {
            parsed = Some(current);
        }
    }
    Ok(parsed)
}

pub(super) fn validate(
    root: &Path,
    admission: VisualImageAdmissionResult,
    files: &[AppMessageFileSnapshot],
    entry: Option<&ModelProviderMetadata>,
) -> Result<Value, GatewayApplicationError> {
    let route = route(entry);
    assert_visual_carrier_matches_catalog(entry, &admission.tuple, &admission.capability, &route)
        .map_err(|error| image_error(error.code))?;
    let checked =
        admit_visual_image_request(admission.tuple, admission.capability, &admission.manifests)
            .map_err(|error| image_error(error.code))?;
    for manifest in &checked.manifests {
        let file = files
            .iter()
            .find(|file| file.id == manifest.file_id && file.kind == "image")
            .ok_or_else(|| {
                public(
                    413,
                    "image_payload_invalid",
                    "이미지 첨부를 확인할 수 없습니다.",
                )
            })?;
        let source = files::source(root, file)?;
        let revision = format!("{}:{}", file.created_at, file.sha256);
        verify_visual_manifest_source(
            manifest,
            &source,
            &ImageSourceRecord {
                size_bytes: usize::try_from(file.size_bytes).unwrap_or(usize::MAX),
                sha256: &file.sha256,
                storage_revision: &revision,
            },
        )
        .map_err(|error| image_error(error.code))?;
        files::verified_derivative(root, manifest)?;
    }
    serde_json::to_value(checked).map_err(|_| GatewayApplicationError::Internal)
}

fn route(entry: Option<&ModelProviderMetadata>) -> crate::context::ImageCarrierTuple {
    let carrier = entry
        .and_then(|entry| entry.image_carrier_protocol.clone())
        .or_else(|| {
            entry.and_then(|entry| match entry.hosted_api_shape {
                Some(HostedApiShape::OpenaiResponses) => Some("openai_responses".into()),
                Some(HostedApiShape::OpenaiChatCompletions) => {
                    Some("openai_chat_completions".into())
                }
                _ => None,
            })
        })
        .unwrap_or_else(|| "fake_vision".into());
    crate::context::ImageCarrierTuple {
        provider_id: entry
            .map(|entry| entry.provider_id.clone())
            .unwrap_or_default(),
        model_id: entry
            .map(|entry| entry.model_id.clone())
            .unwrap_or_default(),
        carrier_protocol: carrier,
        endpoint_profile_id: entry
            .and_then(|entry| entry.image_endpoint_profile_id.clone())
            .unwrap_or_default(),
        catalog_capability_revision: entry
            .and_then(|entry| entry.image_capability_revision.clone())
            .unwrap_or_default(),
        catalog_capability_digest: entry
            .and_then(|entry| entry.image_capability_digest.clone())
            .unwrap_or_default(),
    }
}

fn invalid_queue() -> GatewayApplicationError {
    public(
        409,
        "image_carrier_unverified",
        "Queued image admission is invalid.",
    )
}
