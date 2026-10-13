//! Immutable source definitions. Runtime startup validates registered executors;
//! a catalog entry by itself never grants permission or promises execution.

use std::collections::HashMap;

use serde::Deserialize;
use serde_json::Value;

use super::Capabilities;

pub mod answer_blocks;
mod bridge;
mod validation;
pub use bridge::{BridgeCatalogTool, describe_native, search_native};
pub use validation::validate_native_arguments;

static SOURCE: &str = include_str!("catalog/catalog.json");

/// The bundled tool catalog does not match the registered capabilities.
#[derive(Debug, thiserror::Error)]
pub enum CatalogError {
    /// The bundled catalog JSON could not be parsed.
    #[error("tool catalog source is invalid: {0}")]
    InvalidSource(#[source] serde_json::Error),
    /// A registered capability has no definition in the catalog.
    #[error("tool catalog is missing registered definition {0}")]
    RegisteredDefinitionMissing(String),
    /// A registered capability's definition differs from the catalog.
    #[error("tool catalog definition {0} does not match its registration")]
    RegisteredDefinitionMismatch(String),
}

/// Validated static source bytes have no mutable registry or per-Turn state.
/// Only the Host translates these bytes into the BTCC-owned policy snapshot.
#[derive(Clone, Copy)]
pub struct ToolCatalog {
    source: &'static str,
}

impl ToolCatalog {
    pub fn load(capabilities: &Capabilities) -> Result<Self, CatalogError> {
        Self::validate(SOURCE, capabilities)
    }

    pub fn source(&self) -> Result<String, CatalogError> {
        let mut source: Value =
            serde_json::from_str(self.source).map_err(CatalogError::InvalidSource)?;
        expand_schemas(&mut source)?;
        serde_json::to_string(&source).map_err(CatalogError::InvalidSource)
    }

    fn validate(source: &'static str, capabilities: &Capabilities) -> Result<Self, CatalogError> {
        // Raw definitions are startup-only validation data. Drop their parsed
        // tree before Host builds its single guided snapshot; do not cache both.
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct RegisteredSource {
            raw_definitions: HashMap<String, Value>,
        }
        let parsed: RegisteredSource =
            serde_json::from_str(source).map_err(CatalogError::InvalidSource)?;
        for name in capabilities.registered_names() {
            let actual = capabilities
                .definition(name)
                .ok_or_else(|| CatalogError::RegisteredDefinitionMissing((*name).into()))?;
            let expected = parsed
                .raw_definitions
                .get(*name)
                .ok_or_else(|| CatalogError::RegisteredDefinitionMissing((*name).into()))?;
            if expected != &actual {
                return Err(CatalogError::RegisteredDefinitionMismatch((*name).into()));
            }
        }
        Ok(Self { source })
    }
}

/// Bundled schema references are resolved once, before provider surface selection.
fn expand_schemas(value: &mut Value) -> Result<(), CatalogError> {
    if value.get("$ref").and_then(Value::as_str) == Some("answer-blocks.schema.json") {
        *value = serde_json::from_str(answer_blocks::ANSWER_BLOCKS_SCHEMA)
            .map_err(CatalogError::InvalidSource)?;
        return Ok(());
    }
    match value {
        Value::Object(fields) => {
            for field in fields.values_mut() {
                expand_schemas(field)?;
            }
        }
        Value::Array(items) => {
            for item in items {
                expand_schemas(item)?;
            }
        }
        _ => {}
    }
    Ok(())
}
