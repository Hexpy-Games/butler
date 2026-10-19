//! Evidence for user-managed Chat Completions endpoints.
use super::{ImageLimitField, ImageLimitSources, LocalModelConfig, ModelProviderMetadata};
use sha2::{Digest, Sha256};

pub(super) fn apply(model: &LocalModelConfig, metadata: &mut ModelProviderMetadata) {
    let (supported, source, verified) = if let Some(value) = model.image_input {
        (value, "user", model.updated_at.as_str())
    } else if let Some(result) = &model.image_discovery {
        (
            result.supported,
            "provider_discovery",
            result.verified_at.as_str(),
        )
    } else {
        return;
    };
    let state = serde_json::json!([
        model.api_base_url,
        model.model_id,
        model.platform,
        model.image_input,
        model.image_discovery,
        source,
        verified
    ]);
    let digest = format!("{:x}", Sha256::digest(state.to_string().as_bytes()));
    let endpoint = format!("{:x}", Sha256::digest(model.api_base_url.as_bytes()));
    metadata.image_input_support = Some(
        if supported {
            "supported"
        } else {
            "unsupported"
        }
        .into(),
    );
    metadata.image_capability_source = Some(source.into());
    metadata.image_route_health = Some("unchecked".into());
    metadata.image_input_modalities = Some(if supported {
        vec!["text".into(), "image".into()]
    } else {
        vec!["text".into()]
    });
    metadata.image_carrier_protocol = Some("openai_chat_completions".into());
    metadata.image_endpoint_profile_id = Some(format!("local-chat-{endpoint}"));
    metadata.image_capability_revision = Some(format!("local-image-v1-{digest}"));
    metadata.image_capability_digest = Some(digest);
    metadata.image_capability_source_url = Some(model.server_url.clone());
    metadata.image_capability_verified_at = Some(verified.into());
    // Existing conservative Chat carrier defaults (no provider limit is claimed).
    metadata.image_accepted_mime_types = Some(vec!["image/png".into(), "image/jpeg".into()]);
    metadata.image_max_inline_bytes = Some(10.0 * 1024.0 * 1024.0);
    metadata.image_max_width = Some(16_384.0);
    metadata.image_max_height = Some(16_384.0);
    metadata.image_max_pixels = Some(64_000_000.0);
    metadata.image_limit_sources = Some(ImageLimitSources {
        provider_documented: vec![],
        butler_internal_default: vec![
            ImageLimitField::ImageAcceptedMimeTypes,
            ImageLimitField::ImageMaxInlineBytes,
            ImageLimitField::ImageMaxWidth,
            ImageLimitField::ImageMaxHeight,
            ImageLimitField::ImageMaxPixels,
        ],
    });
}
