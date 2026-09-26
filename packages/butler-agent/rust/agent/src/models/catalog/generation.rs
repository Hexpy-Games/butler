use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::{json, locale::LocaleCollation, models::ModelCatalogError};

use super::ModelProviderMetadata;

pub(super) fn generation(
    models: &[ModelProviderMetadata],
    collation: &LocaleCollation,
) -> Result<String, ModelCatalogError> {
    let mut values = models
        .iter()
        .map(generation_value)
        .collect::<Result<Vec<_>, _>>()?;
    values.sort_by(|left, right| {
        collation.compare(
            left.get("model_ref")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            right
                .get("model_ref")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        )
    });
    let bytes = json::stringify(&Value::Array(values))
        .map_err(|error| ModelCatalogError::new(error.to_string()))?;
    Ok(format!("{:x}", Sha256::digest(bytes.as_bytes())))
}

fn generation_value(model: &ModelProviderMetadata) -> Result<Value, ModelCatalogError> {
    let mut map = Map::new();
    map.insert("model_ref".into(), Value::String(model.model_ref.clone()));
    if let Some(aliases) = &model.aliases {
        let mut aliases = aliases.clone();
        aliases.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        map.insert("aliases".into(), serde_json::to_value(aliases).unwrap());
    }
    if let Some(value) = &model.provider_family_id {
        map.insert("provider_family_id".into(), Value::String(value.clone()));
    }
    map.insert(
        "runtime_supported".into(),
        Value::Bool(model.runtime_supported),
    );
    if let Some(value) = model.hosted_api_shape {
        map.insert(
            "hosted_api_shape".into(),
            serde_json::to_value(value).unwrap(),
        );
    }
    if let Some(value) = model.context_window_tokens {
        map.insert("context_window_tokens".into(), Value::from(value));
    }
    if let Some(value) = model.max_output_tokens {
        map.insert("max_output_tokens".into(), Value::from(value));
    }
    map.insert("source_url".into(), Value::String(model.source_url.clone()));
    let mut efforts = model.reasoning_efforts.clone();
    efforts.sort_by_key(|value| serde_json::to_string(value).unwrap());
    map.insert(
        "reasoning_efforts".into(),
        serde_json::to_value(efforts).unwrap(),
    );
    map.insert(
        "default_reasoning_effort".into(),
        serde_json::to_value(model.default_reasoning_effort).unwrap(),
    );
    Ok(Value::Object(map))
}
