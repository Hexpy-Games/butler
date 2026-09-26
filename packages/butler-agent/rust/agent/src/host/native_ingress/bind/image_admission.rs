//! Host-owned visual fact for this admitted App Turn's Guided surface.

use super::Envelope;
use crate::{
    btcc::AttachmentKind,
    context::{VisualImageAdmissionResult, admit_visual_image_request},
};

pub(super) fn admits_zai_image_tool(envelope: &Envelope) -> bool {
    let Some(value) = envelope.message.image_admission.as_ref() else {
        return false;
    };
    let Ok(admission) = serde_json::from_value::<VisualImageAdmissionResult>(value.clone()) else {
        return false;
    };
    if admit_visual_image_request(
        admission.tuple.clone(),
        admission.capability.clone(),
        &admission.manifests,
    )
    .is_err()
    {
        return false;
    }
    let tuple = &admission.tuple;
    let capability = &admission.capability;
    if tuple.provider_id != "zai"
        || tuple.model_id != "glm-5.2"
        || tuple.carrier_protocol != "zai_mcp_vision"
        || capability.model_support != "supported"
        || capability.route_health != "healthy"
        || capability.tool_server_id.as_deref() != Some("zai-vision")
        || capability.tool_name.as_deref() != Some("analyze_image")
        || capability.tool_capability_digest.as_deref()
            != Some(tuple.catalog_capability_digest.as_str())
    {
        return false;
    }
    admission.manifests.iter().any(|manifest| {
        manifest.kind == "image"
            && envelope.message.attachments.iter().any(|attachment| {
                attachment.kind == AttachmentKind::Image && attachment.id == manifest.file_id
            })
    })
}
