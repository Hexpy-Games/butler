//! Immutable source definitions. Runtime startup validates registered executors;
//! a catalog entry by itself never grants permission or promises execution.

use serde_json::Value;

use super::Capabilities;

pub mod answer_blocks;
mod bridge;
mod validation;
pub use bridge::{BridgeCatalogTool, describe_native, search_native};
pub use validation::validate_native_arguments;

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

/// Validated, resolved source bytes have no mutable registry or per-Turn state.
/// Only the Host translates these bytes into the BTCC-owned policy snapshot.
#[derive(Clone)]
pub struct ToolCatalog {
    source: String,
}

impl ToolCatalog {
    pub fn load(capabilities: &Capabilities) -> Result<Self, CatalogError> {
        let parsed = butler_core::tool_catalog::load().map_err(CatalogError::InvalidSource)?;
        Self::validate(&parsed, capabilities)
    }

    pub fn source(&self) -> &str {
        &self.source
    }

    fn validate(parsed: &Value, capabilities: &Capabilities) -> Result<Self, CatalogError> {
        // Raw definitions are startup-only validation data. The Host retains
        // only its single guided snapshot after consuming the resolved bytes.
        let raw = parsed
            .get("rawDefinitions")
            .and_then(Value::as_object)
            .ok_or_else(|| CatalogError::RegisteredDefinitionMissing("rawDefinitions".into()))?;
        for name in capabilities.registered_names() {
            let actual = capabilities
                .definition(name)
                .ok_or_else(|| CatalogError::RegisteredDefinitionMissing((*name).into()))?;
            let expected = raw
                .get(*name)
                .ok_or_else(|| CatalogError::RegisteredDefinitionMissing((*name).into()))?;
            if expected != &actual {
                return Err(CatalogError::RegisteredDefinitionMismatch((*name).into()));
            }
        }
        let source = serde_json::to_string(parsed).map_err(CatalogError::InvalidSource)?;
        Ok(Self { source })
    }
}
