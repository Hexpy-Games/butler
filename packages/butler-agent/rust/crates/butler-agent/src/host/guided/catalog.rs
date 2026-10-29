//! One source catalog translated at host composition, with executable coverage
//! checked separately from BTCC's authority and provider-surface selection.

use butler_runtime::capabilities::{Capabilities, CatalogError, ToolCatalog};
use butler_turn::btcc::{BtccError, GuidedCatalogSnapshot};

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
pub(crate) struct GuidedCatalog {
    snapshot: GuidedCatalogSnapshot,
    plan_effects: std::collections::HashSet<String>,
}

impl GuidedCatalog {
    pub(crate) fn load(capabilities: &Capabilities) -> Result<Self, GuidedCatalogError> {
        let source = ToolCatalog::load(capabilities).map_err(GuidedCatalogError::Source)?;
        let snapshot =
            GuidedCatalogSnapshot::parse(source.source()).map_err(GuidedCatalogError::Policy)?;
        let plan_effects = snapshot.steward_plan_effects().map(str::to_owned).collect();
        Ok(Self {
            snapshot,
            plan_effects,
        })
    }

    pub(crate) fn steward_plan_effect(&self, name: &str) -> bool {
        self.plan_effects.contains(name)
    }

    pub(crate) fn snapshot(&self) -> &GuidedCatalogSnapshot {
        &self.snapshot
    }
}

#[cfg(test)]
mod tests;
