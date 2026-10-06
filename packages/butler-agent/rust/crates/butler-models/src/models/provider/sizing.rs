//! Return pressure and exact stateless bytes from a single serialization.
use crate::models::{ModelCatalog, ModelCatalogSnapshot, TokenEstimateInput};
use butler_turn::btcc::{BtccError, ContextMeasurement, ModelRoundMessage};

pub(super) fn measure(
    catalog: &ModelCatalog,
    snapshot: &ModelCatalogSnapshot,
    model: &str,
    messages: &[ModelRoundMessage],
) -> Result<ContextMeasurement, BtccError> {
    let value = if model.starts_with("openai/") {
        serde_json::Value::Array(super::serialize::bounded_items(messages))
    } else {
        serde_json::to_value(messages).map_err(|source| {
            butler_turn::btcc::BtccError::relayed(
                "context_serialization_failed",
                "Context serialization failed.",
            )
            .with_source(source)
        })?
    };
    let bytes = butler_core::json::stringify(&value).map_err(|source| {
        butler_turn::btcc::BtccError::relayed(
            "context_serialization_failed",
            "Context serialization failed.",
        )
        .with_source(source)
    })?;
    let tokens = catalog
        .estimate_tokens(snapshot, TokenEstimateInput::Text(&bytes), Some(model))
        .map_err(|source| {
            butler_turn::btcc::BtccError::relayed(
                "context_tokenization_failed",
                "Context tokenization failed.",
            )
            .with_source(source)
        })?
        .tokens;
    Ok(butler_turn::btcc::ContextMeasurement {
        pressure_bytes: tokens * 2.0,
        stateless_bytes: model.starts_with("openai/").then_some(bytes.len()),
    })
}
