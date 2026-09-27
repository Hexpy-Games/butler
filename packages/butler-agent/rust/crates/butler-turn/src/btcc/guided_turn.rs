//! Source-compatible preparation before the model round is bound to a Turn.

mod authority;
mod phase;
mod work;

pub use authority::{GuidedAuthorityDecision, guided_authority_loop_decision};
pub use phase::{
    GuidedCatalogRead, GuidedCatalogSnapshot, GuidedPhase, GuidedPhaseInput, GuidedPhaseSelection,
    LedgerEffects, SurfaceMode, select_phase,
};
pub use work::{GuidedPreparationError, GuidedWork, load_guided_turn_work, work_scope_for_turn};

#[cfg(test)]
mod tests;
