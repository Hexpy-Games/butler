//! Immutable source definitions. Runtime startup validates registered executors;
//! a catalog entry by itself never grants permission or promises execution.

use std::collections::HashMap;

use serde::Deserialize;
use serde_json::Value;

use super::NativeCapabilities;

mod bridge;
mod validation;
pub(crate) use bridge::{BridgeCatalogTool, describe_native, search_native};
pub(crate) use validation::validate_native_arguments;

static SOURCE: &str = include_str!("catalog/catalog.json");

/// The bundled tool catalog does not match the registered capabilities.
#[derive(Debug, thiserror::Error)]
pub(crate) enum CatalogError {
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
pub(crate) struct NativeToolCatalog {
    source: &'static str,
}

impl NativeToolCatalog {
    pub(crate) fn load(capabilities: &NativeCapabilities) -> Result<Self, CatalogError> {
        Self::validate(SOURCE, capabilities)
    }

    pub(crate) fn source(&self) -> &'static str {
        self.source
    }

    fn validate(
        source: &'static str,
        capabilities: &NativeCapabilities,
    ) -> Result<Self, CatalogError> {
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

#[cfg(test)]
mod tests;
