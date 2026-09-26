//! Pure guided tool admission over the host's one immutable capability catalog.

mod catalog;
mod instructions;
mod policy;
mod selection;
mod visibility;

pub(crate) use catalog::{GuidedCatalogRead, GuidedCatalogSnapshot};
pub(crate) use selection::{GuidedPhaseInput, GuidedPhaseSelection, select_phase};

#[cfg(test)]
mod tests;
