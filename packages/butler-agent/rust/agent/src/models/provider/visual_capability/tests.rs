
use tokio_util::sync::CancellationToken;

use crate::{
    btcc::{ModelRoundError, ModelRoundRequest, ReasoningEffort},
    locale::LocaleCollation,
    models::{
        ImageAdmissionError, ModelCatalog, ModelCatalogSnapshotInput, ModelProviderMetadata,
        ProviderVisualCapabilityFuture, ProviderVisualCapabilityPort, VisualAttachmentManifest,
        image_admission_for_catalog_entry,
    },
};

use super::refresh_current_zai_capability;

static HIGH_EFFORT: ReasoningEffort = ReasoningEffort::High;

struct LiveDigest(&'static str);

impl ProviderVisualCapabilityPort for LiveDigest {
    fn zai_vision_tool_capability_digest<'a>(
        &'a self,
        metadata: &'a ModelProviderMetadata,
        cancellation: &'a CancellationToken,
    ) -> ProviderVisualCapabilityFuture<'a> {
        Box::pin(async move {
            if cancellation.is_cancelled()
                || metadata.provider_id != "zai"
                || metadata.model_id != "glm-5.2"
            {
                return Err(());
            }
            Ok(self.0.to_owned())
        })
    }
}

fn zai_metadata() -> ModelProviderMetadata {
    let catalog = ModelCatalog::new().unwrap();
    let snapshot = catalog
        .snapshot(
            ModelCatalogSnapshotInput {
                configured_local: Vec::new(),
                extra_models: Vec::new(),
                registered_models: Vec::new(),
                credential_views: Vec::new(),
                default_model_ref: None,
                generated_at: "now".into(),
            },
            &LocaleCollation::new("en-US").unwrap(),
        )
        .unwrap();
    snapshot.find_model_metadata(Some("zai/glm-5.2")).unwrap()
}

fn manifest() -> VisualAttachmentManifest {
    VisualAttachmentManifest {
        kind: "image".into(),
        file_id: "file-1".into(),
        position: 0,
        safe_name: "image.png".into(),
        mime_type: "image/png".into(),
        sniffed_mime_type: "image/png".into(),
        sniffed_magic: "png".into(),
        storage_revision: "storage-1".into(),
        source_size_bytes: 10,
        source_digest: "a".repeat(64),
        derivative_id: "derivative-1".into(),
        derivative_mime_type: "image/png".into(),
        derivative_size_bytes: 8,
        derivative_digest: "b".repeat(64),
        width: 1,
        height: 1,
        pixel_count: 1,
        sanitizer_revision: "sanitizer-1".into(),
        manifest_digest: "c".repeat(64),
    }
}

fn admitted(
    metadata: &ModelProviderMetadata,
    manifest: &VisualAttachmentManifest,
) -> Result<crate::models::VisualImageAdmissionResult, ImageAdmissionError> {
    image_admission_for_catalog_entry(Some(metadata), std::slice::from_ref(manifest))
}

fn request<'a>(
    tuple: &'a serde_json::Value,
    capability: &'a serde_json::Value,
    manifests: &'a [serde_json::Value],
) -> ModelRoundRequest<'a> {
    ModelRoundRequest {
        max_output_tokens: None,
        round_id: None,
        model: "zai/glm-5.2",
        messages: &[],
        instructions: None,
        tools: &[],
        tool_surface_digest: None,
        tool_choice: None,
        reasoning_effort: &HIGH_EFFORT,
        cancellation: CancellationToken::new(),
        attachments: &[],
        image_carrier: Some(tuple),
        image_capability: Some(capability),
        image_manifests: manifests,
        verified_image_payload: None,
        butler_data: None,
        usage_attribution: None,
        cache_scope: None,
        stable_provider_cache_prefix: None,
        route_context: None,
        provider_retry_attempts: None,
        route_transport_attempt_ordinal: None,
        continuation: None,
        bounded_continuation: None,
        provider_body_admission: None,
        stream_observer: None,
        identity_observer: None,
    }
}

#[tokio::test]
async fn provider_reuses_live_zai_digest_and_rejects_frozen_old_admission() {
    let mut metadata = zai_metadata();
    let manifest = manifest();
    let old = admitted(&metadata, &manifest).unwrap();
    let old_tuple = serde_json::to_value(old.tuple).unwrap();
    let old_capability = serde_json::to_value(old.capability).unwrap();
    let old_manifests = serde_json::to_value(old.manifests).unwrap();

    refresh_current_zai_capability(
        &mut metadata,
        Some(&LiveDigest("live-schema-digest")),
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(
        metadata.image_capability_digest.as_deref(),
        Some("live-schema-digest")
    );
    assert_eq!(metadata.image_route_health.as_deref(), Some("healthy"));
    assert_eq!(
        metadata.image_tool_capability_digest.as_deref(),
        Some("live-schema-digest")
    );

    let old_request = request(
        &old_tuple,
        &old_capability,
        old_manifests.as_array().unwrap(),
    );
    assert!(matches!(
        super::super::visual::validate(&old_request, &metadata),
        Err(ModelRoundError::ImageAdmission { .. })
    ));

    let current = admitted(&metadata, &manifest).unwrap();
    let tuple = serde_json::to_value(current.tuple).unwrap();
    let capability = serde_json::to_value(current.capability).unwrap();
    let manifests = serde_json::to_value(current.manifests).unwrap();
    let current_request = request(&tuple, &capability, manifests.as_array().unwrap());
    super::super::visual::validate(&current_request, &metadata).unwrap();
}
