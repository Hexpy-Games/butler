//! Pure guided tool admission over the host's one immutable capability catalog.

mod catalog;
mod instructions;
mod policy;
mod selection;
mod visibility;

pub use catalog::{GuidedCatalogRead, GuidedCatalogSnapshot, LedgerEffects};
pub use selection::{
    GuidedPhase, GuidedPhaseInput, GuidedPhaseSelection, SurfaceMode, select_phase,
};
