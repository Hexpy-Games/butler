use tokio_util::sync::CancellationToken;

use crate::{
    btcc::ModelRoundError,
    models::{ModelProviderMetadata, ProviderVisualCapabilityPort},
};

const ZAI_PROVIDER: &str = "zai";
const ZAI_MODEL: &str = "glm-5.2";
const ZAI_CARRIER: &str = "zai_mcp_vision";

pub(super) async fn refresh_current_zai_capability(
    metadata: &mut ModelProviderMetadata,
    port: Option<&dyn ProviderVisualCapabilityPort>,
    cancellation: &CancellationToken,
) -> Result<(), ModelRoundError> {
    if metadata.image_carrier_protocol.as_deref() != Some(ZAI_CARRIER) {
        return Ok(());
    }
    if metadata.provider_id != ZAI_PROVIDER || metadata.model_id != ZAI_MODEL {
        return Err(unavailable());
    }
    if cancellation.is_cancelled() {
        return Err(ModelRoundError::Cancelled);
    }
    let Some(port) = port else {
        return Err(unavailable());
    };
    let digest = match port
        .zai_vision_tool_capability_digest(metadata, cancellation)
        .await
    {
        Ok(digest) => digest,
        Err(()) if cancellation.is_cancelled() => return Err(ModelRoundError::Cancelled),
        Err(()) => return Err(unavailable()),
    };
    if cancellation.is_cancelled() {
        return Err(ModelRoundError::Cancelled);
    }
    metadata.image_input_support = Some("supported".into());
    metadata.image_capability_source = Some("provider_discovery".into());
    metadata.image_route_health = Some("healthy".into());
    metadata.image_capability_digest = Some(digest.clone());
    metadata.image_tool_capability_digest = Some(digest);
    metadata.image_tool_server_id = Some("zai-vision".into());
    metadata.image_tool_name = Some("analyze_image".into());
    Ok(())
}

fn unavailable() -> ModelRoundError {
    ModelRoundError::ImageAdmission {
        code: "image_carrier_unavailable".into(),
        reason: "current_route_capability_unavailable".into(),
    }
}

#[cfg(test)]
mod tests;
