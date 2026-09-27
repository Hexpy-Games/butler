//! Pure guided tool admission over the host's one immutable capability catalog.

mod catalog;
mod instructions;
mod policy;
mod selection;
mod visibility;

pub use catalog::{GuidedCatalogRead, GuidedCatalogSnapshot};
pub use selection::{GuidedPhaseInput, GuidedPhaseSelection, select_phase};
