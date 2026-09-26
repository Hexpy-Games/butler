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

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum CatalogError {
    InvalidSource(String),
    RegisteredDefinitionMissing(String),
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
        let parsed: RegisteredSource = serde_json::from_str(source)
            .map_err(|error| CatalogError::InvalidSource(error.to_string()))?;
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
