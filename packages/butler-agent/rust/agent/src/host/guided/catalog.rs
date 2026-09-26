//! One source catalog translated at host composition, with executable coverage
//! checked separately from BTCC's authority and provider-surface selection.

use crate::btcc::{BtccError, GuidedCatalogSnapshot};
use crate::capabilities::{CatalogError, NativeCapabilities, NativeToolCatalog};

#[derive(Debug)]
pub(crate) enum GuidedCatalogError {
    Source(CatalogError),
    Policy(BtccError),
}

impl std::fmt::Display for GuidedCatalogError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Source(error) => write!(formatter, "Source({error:?})"),
            Self::Policy(error) => write!(formatter, "Policy({error:?})"),
        }
    }
}

/// The host owns this once and borrows its snapshot during each Turn's policy
/// selection. No service owner, model response, or Turn is retained here.
pub(crate) struct NativeGuidedCatalog {
    snapshot: GuidedCatalogSnapshot,
}

impl NativeGuidedCatalog {
    pub(crate) fn load(capabilities: &NativeCapabilities) -> Result<Self, GuidedCatalogError> {
        let source = NativeToolCatalog::load(capabilities).map_err(GuidedCatalogError::Source)?;
        let snapshot =
            GuidedCatalogSnapshot::parse(source.source()).map_err(GuidedCatalogError::Policy)?;
        Ok(Self { snapshot })
    }

    pub(crate) fn snapshot(&self) -> &GuidedCatalogSnapshot {
        &self.snapshot
    }
}

#[cfg(test)]
mod tests;
