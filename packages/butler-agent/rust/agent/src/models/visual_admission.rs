//! Exact-model, path-free visual admission over borrowed Models catalog facts.

use serde::{Deserialize, Serialize};

use super::visual_manifest::VisualAttachmentManifest;
use crate::models::{HostedApiShape, ModelProviderMetadata};
use crate::public_text::trim_js_whitespace;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImageCarrierTuple {
    pub provider_id: String,
    pub model_id: String,
    pub carrier_protocol: String,
    pub endpoint_profile_id: String,
    pub catalog_capability_revision: String,
    pub catalog_capability_digest: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImageCapabilityEvidence {
    pub provider_id: String,
    pub model_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_id: Option<String>,
    pub carrier_protocol: String,
    pub endpoint_profile_id: String,
    pub catalog_capability_revision: String,
    pub catalog_capability_digest: String,
    pub model_support: String,
    pub capability_source: String,
    pub route_health: String,
    pub input_modalities: Vec<String>,
    pub accepted_mime_types: Vec<String>,
    pub max_inline_image_bytes: f64,
    pub max_width: f64,
    pub max_height: f64,
    pub max_pixels: f64,
    pub source_url: String,
    pub verified_at: String,
    pub evidence_revision: String,
    pub evidence_digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_server_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_capability_digest: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VisualImageAdmissionResult {
    pub tuple: ImageCarrierTuple,
    pub capability: ImageCapabilityEvidence,
    pub manifests: Vec<VisualAttachmentManifest>,
}

/// A visual attachment was refused for the selected model; `code` is the
/// wire code and `message` the refusal detail.
#[derive(Debug, thiserror::Error)]
#[error("{code}: {message}")]
pub(crate) struct ImageAdmissionError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}
impl ImageAdmissionError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}
type ImageAdmissionResult<T> = Result<T, ImageAdmissionError>;

fn error(code: &'static str, detail: &'static str) -> ImageAdmissionError {
    ImageAdmissionError::new(code, detail)
}

fn optional_nonempty(value: Option<&String>) -> Option<String> {
    value.filter(|value| !value.is_empty()).cloned()
}

fn catalog_carrier(entry: &ModelProviderMetadata) -> Option<&str> {
    entry
        .image_carrier_protocol
        .as_deref()
        .or(match entry.hosted_api_shape {
            Some(HostedApiShape::OpenaiResponses) => Some("openai_responses"),
            Some(HostedApiShape::OpenaiChatCompletions) => Some("openai_chat_completions"),
            _ => None,
        })
}

fn assert_catalog(
    entry: Option<&ModelProviderMetadata>,
) -> ImageAdmissionResult<&ModelProviderMetadata> {
    let Some(entry) = entry.filter(|entry| entry.runtime_supported) else {
        return Err(error(
            "image_model_unsupported",
            "runtime_model_unavailable",
        ));
    };
    match entry.image_input_support.as_deref() {
        Some("unsupported") => {
            return Err(error(
                "image_model_unsupported",
                "catalog_image_support_unsupported",
            ));
        }
        Some("supported") => {}
        _ => {
            return Err(error(
                "image_capability_unknown",
                "catalog_image_support_unknown",
            ));
        }
    }
    if entry.image_route_health.as_deref() == Some("incompatible") {
        return Err(error(
            "image_route_incompatible",
            "exact_route_incompatible",
        ));
    }
    if catalog_carrier(entry).is_none() {
        return Err(error(
            "image_carrier_unavailable",
            "adapter_carrier_missing",
        ));
    }
    Ok(entry)
}

fn tuple_from_catalog(entry: &ModelProviderMetadata) -> ImageAdmissionResult<ImageCarrierTuple> {
    let tuple = ImageCarrierTuple {
        provider_id: trim_js_whitespace(&entry.provider_id).to_owned(),
        model_id: trim_js_whitespace(&entry.model_id).to_owned(),
        carrier_protocol: catalog_carrier(entry).unwrap_or_default().to_owned(),
        endpoint_profile_id: entry
            .image_endpoint_profile_id
            .as_deref()
            .map(trim_js_whitespace)
            .unwrap_or_default()
            .to_owned(),
        catalog_capability_revision: entry
            .image_capability_revision
            .as_deref()
            .map(trim_js_whitespace)
            .unwrap_or_default()
            .to_owned(),
        catalog_capability_digest: entry
            .image_capability_digest
            .as_deref()
            .map(trim_js_whitespace)
            .unwrap_or_default()
            .to_owned(),
    };
    if tuple.provider_id.is_empty()
        || tuple.model_id.is_empty()
        || tuple.carrier_protocol.is_empty()
        || tuple.endpoint_profile_id.is_empty()
        || tuple.catalog_capability_revision.is_empty()
        || tuple.catalog_capability_digest.is_empty()
    {
        return Err(error(
            "image_carrier_unavailable",
            "catalog_tuple_incomplete",
        ));
    }
    Ok(tuple)
}

fn evidence_from_catalog(
    entry: &ModelProviderMetadata,
    tuple: &ImageCarrierTuple,
) -> ImageAdmissionResult<ImageCapabilityEvidence> {
    let source_url = entry
        .image_capability_source_url
        .as_deref()
        .map(trim_js_whitespace)
        .unwrap_or_default();
    let verified_at = entry
        .image_capability_verified_at
        .as_deref()
        .map(trim_js_whitespace)
        .unwrap_or_default();
    if source_url.is_empty() || verified_at.is_empty() {
        return Err(error(
            "image_carrier_unverified",
            "catalog_evidence_incomplete",
        ));
    }
    Ok(ImageCapabilityEvidence {
        provider_id: tuple.provider_id.clone(),
        model_id: tuple.model_id.clone(),
        credential_id: optional_nonempty(entry.credential_id.as_ref()),
        carrier_protocol: tuple.carrier_protocol.clone(),
        endpoint_profile_id: tuple.endpoint_profile_id.clone(),
        catalog_capability_revision: tuple.catalog_capability_revision.clone(),
        catalog_capability_digest: tuple.catalog_capability_digest.clone(),
        model_support: entry
            .image_input_support
            .clone()
            .unwrap_or_else(|| "unknown".into()),
        capability_source: entry
            .image_capability_source
            .clone()
            .unwrap_or_else(|| "unknown".into()),
        route_health: entry
            .image_route_health
            .clone()
            .unwrap_or_else(|| "unchecked".into()),
        input_modalities: entry.image_input_modalities.clone().unwrap_or_default(),
        accepted_mime_types: entry.image_accepted_mime_types.clone().unwrap_or_default(),
        max_inline_image_bytes: entry.image_max_inline_bytes.unwrap_or(0.0),
        max_width: entry.image_max_width.unwrap_or(0.0),
        max_height: entry.image_max_height.unwrap_or(0.0),
        max_pixels: entry.image_max_pixels.unwrap_or(0.0),
        source_url: source_url.to_owned(),
        verified_at: verified_at.to_owned(),
        evidence_revision: tuple.catalog_capability_revision.clone(),
        evidence_digest: tuple.catalog_capability_digest.clone(),
        tool_server_id: optional_nonempty(entry.image_tool_server_id.as_ref()),
        tool_name: optional_nonempty(entry.image_tool_name.as_ref()),
        tool_capability_digest: optional_nonempty(entry.image_tool_capability_digest.as_ref()),
    })
}

pub(crate) fn assert_visual_carrier_matches_catalog(
    entry: Option<&ModelProviderMetadata>,
    actual_tuple: &ImageCarrierTuple,
    actual_capability: &ImageCapabilityEvidence,
    resolved_route: &ImageCarrierTuple,
) -> ImageAdmissionResult<(ImageCarrierTuple, ImageCapabilityEvidence)> {
    let entry = assert_catalog(entry)?;
    let tuple = tuple_from_catalog(entry)?;
    let capability = evidence_from_catalog(entry, &tuple)?;
    if actual_tuple != &tuple {
        return Err(error(
            "image_carrier_unverified",
            "caller_tuple_catalog_mismatch",
        ));
    }
    if actual_capability != &capability {
        return Err(error(
            "image_carrier_unverified",
            "caller_evidence_catalog_mismatch",
        ));
    }
    if resolved_route != &tuple {
        return Err(error(
            "image_carrier_unverified",
            "caller_tuple_catalog_mismatch",
        ));
    }
    if !entry.model_ref.is_empty()
        && entry.model_ref != format!("{}/{}", tuple.provider_id, tuple.model_id)
    {
        return Err(error(
            "image_carrier_unverified",
            "catalog_model_ref_mismatch",
        ));
    }
    Ok((tuple, capability))
}

pub(crate) fn image_admission_for_catalog_entry(
    entry: Option<&ModelProviderMetadata>,
    manifests: &[VisualAttachmentManifest],
) -> ImageAdmissionResult<VisualImageAdmissionResult> {
    let entry = assert_catalog(entry)?;
    let tuple = tuple_from_catalog(entry)?;
    let capability = evidence_from_catalog(entry, &tuple)?;
    admit_visual_image_request(tuple, capability, manifests)
}

pub(crate) fn admit_visual_image_request(
    tuple: ImageCarrierTuple,
    capability: ImageCapabilityEvidence,
    manifests: &[VisualAttachmentManifest],
) -> ImageAdmissionResult<VisualImageAdmissionResult> {
    if tuple.provider_id.is_empty()
        || tuple.model_id.is_empty()
        || tuple.carrier_protocol.is_empty()
        || tuple.endpoint_profile_id.is_empty()
        || tuple.catalog_capability_revision.is_empty()
        || tuple.catalog_capability_digest.is_empty()
        || capability.provider_id.is_empty()
        || capability.model_id.is_empty()
        || capability.endpoint_profile_id.is_empty()
        || capability.evidence_digest.is_empty()
        || capability.evidence_revision.is_empty()
        || capability.verified_at.is_empty()
        || capability.model_support.is_empty()
        || capability.capability_source.is_empty()
        || capability.route_health.is_empty()
    {
        return Err(error(
            "image_carrier_unverified",
            "tuple_or_evidence_missing",
        ));
    }
    if capability.model_support != "supported" {
        return Err(error(
            if capability.model_support == "unsupported" {
                "image_model_unsupported"
            } else {
                "image_capability_unknown"
            },
            "frozen_model_support_invalid",
        ));
    }
    if capability.route_health == "incompatible" {
        return Err(error(
            "image_route_incompatible",
            "frozen_route_incompatible",
        ));
    }
    if capability.provider_id != tuple.provider_id
        || capability.model_id != tuple.model_id
        || capability.carrier_protocol != tuple.carrier_protocol
        || capability.endpoint_profile_id != tuple.endpoint_profile_id
        || capability.catalog_capability_revision != tuple.catalog_capability_revision
        || capability.catalog_capability_digest != tuple.catalog_capability_digest
        || capability.evidence_revision != tuple.catalog_capability_revision
        || capability.evidence_digest != tuple.catalog_capability_digest
    {
        return Err(error("image_carrier_unverified", "tuple_evidence_mismatch"));
    }
    if !capability
        .input_modalities
        .iter()
        .any(|modality| modality.to_lowercase() == "image")
    {
        return Err(error("image_model_unsupported", "image_modality_missing"));
    }
    if manifests.is_empty() {
        return Err(error("image_manifest_invalid", "manifest_missing"));
    }
    let mut ordered = manifests.to_vec();
    ordered.sort_by_key(|manifest| manifest.position);
    for (position, manifest) in ordered.iter().enumerate() {
        if manifest.kind != "image"
            || manifest.position != position
            || manifest.file_id.is_empty()
            || manifest.source_digest.len() != 64
            || manifest.derivative_digest.len() != 64
            || manifest.manifest_digest.len() != 64
            || manifest.derivative_size_bytes == 0
            || manifest.width == 0
            || manifest.height == 0
            || manifest.pixel_count == 0
            || manifest.storage_revision.is_empty()
            || manifest.sniffed_magic.is_empty()
            || manifest.sniffed_mime_type.is_empty()
        {
            return Err(error("image_manifest_invalid", "manifest_shape_invalid"));
        }
        if !capability
            .accepted_mime_types
            .iter()
            .any(|mime| mime.to_lowercase() == manifest.derivative_mime_type.to_lowercase())
        {
            return Err(error("image_model_unsupported", "mime_not_admitted"));
        }
        if (manifest.derivative_size_bytes as f64) > capability.max_inline_image_bytes
            || manifest.derivative_size_bytes > 10 * 1024 * 1024
            || f64::from(manifest.width) > capability.max_width
            || f64::from(manifest.height) > capability.max_height
            || (manifest.pixel_count as f64) > capability.max_pixels
        {
            return Err(error("image_payload_invalid", "image_limit_exceeded"));
        }
    }
    Ok(VisualImageAdmissionResult {
        tuple,
        capability,
        manifests: ordered,
    })
}
