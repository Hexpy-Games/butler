//! Measure text/image pressure separately from the complete stateless wire bytes.
use std::borrow::Cow;

use crate::models::{ModelCatalog, ModelCatalogSnapshot, TokenEstimateInput};
use butler_turn::btcc::{BtccError, ContextMeasurement, ModelRoundMessage};

#[derive(Default)]
pub(super) struct Cache(parking_lot::Mutex<super::prefix_diagnostics::components::Cache>);

pub(super) fn measure(
    catalog: &ModelCatalog,
    snapshot: &ModelCatalogSnapshot,
    model: &str,
    messages: &[ModelRoundMessage],
    cache: &Cache,
) -> Result<ContextMeasurement, BtccError> {
    let items = if model.starts_with("openai/") {
        super::serialize::bounded_items(messages)
    } else {
        Vec::new()
    };
    let (bytes, projected, images) = if model.starts_with("openai/") {
        cache.0.lock().array_sizing(&items).map_err(|source| {
            BtccError::relayed(
                "context_serialization_failed",
                "Context serialization failed.",
            )
            .with_source(source)
        })?
    } else {
        let value = serde_json::to_value(messages).map_err(|source| {
            BtccError::relayed(
                "context_serialization_failed",
                "Context serialization failed.",
            )
            .with_source(source)
        })?;
        let bytes = butler_core::json::stringify(&value).map_err(|source| {
            BtccError::relayed(
                "context_serialization_failed",
                "Context serialization failed.",
            )
            .with_source(source)
        })?;
        (bytes, String::new(), 0)
    };
    let token_input = if model.starts_with("openai/") {
        Cow::Owned(projected)
    } else {
        Cow::Borrowed(bytes.as_str())
    };
    let tokens = catalog
        .estimate_tokens(
            snapshot,
            TokenEstimateInput::Text(&token_input),
            Some(model),
        )
        .map_err(|source| {
            butler_turn::btcc::BtccError::relayed(
                "context_tokenization_failed",
                "Context tokenization failed.",
            )
            .with_source(source)
        })?
        .tokens
        + f64::from(images) * crate::models::request_admission::IMAGE_TOKEN_ALLOWANCE;
    Ok(butler_turn::btcc::ContextMeasurement {
        pressure_bytes: tokens * 2.0,
        stateless_bytes: model.starts_with("openai/").then_some(bytes.len()),
    })
}
