use crate::{
    gateway::GatewayApplicationError,
    mcp_client::NativeMcpClient,
    models::{
        ModelConfiguration, ModelProviderMetadata, ProviderVisualCapabilityFuture,
        ProviderVisualCapabilityPort,
    },
};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub(crate) struct NativeZaiVisionCapability {
    mcp: Arc<NativeMcpClient>,
}

impl NativeZaiVisionCapability {
    pub(crate) fn new(mcp: Arc<NativeMcpClient>) -> Self {
        Self { mcp }
    }
}

impl ProviderVisualCapabilityPort for NativeZaiVisionCapability {
    fn zai_vision_tool_capability_digest<'a>(
        &'a self,
        metadata: &'a ModelProviderMetadata,
        cancellation: &'a CancellationToken,
    ) -> ProviderVisualCapabilityFuture<'a> {
        Box::pin(async move {
            Box::pin(self.mcp.zai_vision_tool_capability_digest(
                &metadata.provider_id,
                &metadata.model_id,
                metadata.credential_id.as_deref(),
                cancellation,
            ))
            .await
            .map_err(|_| ())
        })
    }
}

/// Returns current public model facts and freezes the live Z.AI image carrier
/// digest into the existing admitted catalog entry. No provider request or
/// model credential resolution is performed here.
pub(crate) async fn catalog_for_visual_admission(
    models: &ModelConfiguration,
    mcp: &NativeMcpClient,
    model_ref: &str,
) -> Result<Vec<ModelProviderMetadata>, GatewayApplicationError> {
    let read = models
        .read()
        .await
        .map_err(|_| GatewayApplicationError::Internal)?;
    let mut catalog = read.catalog.view().registered_models.clone();
    let Some(entry) = catalog
        .iter_mut()
        .find(|entry| entry.model_ref == model_ref)
    else {
        return Ok(catalog);
    };
    if entry.provider_id != "zai"
        || entry.model_id != "glm-5.2"
        || entry.image_carrier_protocol.as_deref() != Some("zai_mcp_vision")
    {
        return Ok(catalog);
    }
    let digest = Box::pin(mcp.zai_vision_tool_capability_digest(
        &entry.provider_id,
        &entry.model_id,
        entry.credential_id.as_deref(),
        &CancellationToken::new(),
    ))
    .await
    .map_err(|_| carrier_unavailable())?;
    entry.image_input_support = Some("supported".into());
    entry.image_capability_source = Some("provider_discovery".into());
    entry.image_route_health = Some("healthy".into());
    entry.image_capability_digest = Some(digest.clone());
    entry.image_tool_capability_digest = Some(digest);
    entry.image_tool_server_id = Some("zai-vision".into());
    entry.image_tool_name = Some("analyze_image".into());
    Ok(catalog)
}

fn carrier_unavailable() -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status: 409,
        code: "image_carrier_unavailable".into(),
        message: "The Z.AI image carrier could not be verified.".into(),
    }
}
