//! Config-file selection for memory jobs running outside the App.
use super::{
    ModelCatalog, ModelCatalogError, ModelCatalogSnapshotInput, normalize_local_model_config,
    normalize_registered_hosted_model, registered_hosted_model_metadata,
};
use butler_core::locale::LocaleCollation;
use serde_json::Value;

/// Resolve background work from a config-file snapshot. This performs no
/// network or credential-store access; removed registrations are unavailable.
pub fn background_model_from_config(
    config: &Value,
    explicit: Option<&str>,
    fallback: &str,
) -> String {
    let background = config
        .pointer("/system/backgroundModel")
        .and_then(Value::as_str);
    butler_core::configuration::resolve_background_model(
        explicit,
        background,
        Some(fallback),
        |value| selectable(config, value).unwrap_or(false),
    )
    .unwrap_or(fallback)
    .to_owned()
}

fn selectable(config: &Value, requested: &str) -> Result<bool, ModelCatalogError> {
    let catalog = ModelCatalog::new()?;
    let snapshot = catalog.snapshot(
        ModelCatalogSnapshotInput {
            configured_local: vec![],
            extra_models: vec![],
            registered_models: vec![],
            credential_views: vec![],
            default_model_ref: None,
            generated_at: String::new(),
        },
        &LocaleCollation::new("en")
            .map_err(|error| ModelCatalogError::Rejected(error.to_string().into()))?,
    )?;
    let registered = config
        .pointer("/models/registered")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|value| normalize_registered_hosted_model(value, &snapshot, ""))
        .collect::<Vec<_>>();
    let hosted = registered_hosted_model_metadata(&registered, &snapshot, &[], &[], None);
    let local = config
        .pointer("/models/local")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|value| normalize_local_model_config(value, ""))
        .map(|value| super::ModelProviderMetadata::from(&value));
    let routine = catalog.default_preset(config, &Value::Null).model;
    Ok(hosted.into_iter().chain(local).any(|model| {
        model.model_ref == requested
            && model.runtime_supported
            && model.enabled != Some(false)
            && !model.is_image_output()
    }) || (!registered.is_empty()
        && routine == requested
        && snapshot
            .find_model_metadata(Some(requested))
            .is_some_and(|model| model.runtime_supported && !model.is_image_output())))
}
