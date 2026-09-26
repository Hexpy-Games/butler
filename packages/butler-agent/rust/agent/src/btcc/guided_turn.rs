//! Source-compatible preparation before the model round is bound to a Turn.

mod authority;
mod phase;
mod work;

pub(crate) use authority::{GuidedAuthorityDecision, guided_authority_loop_decision};
pub(crate) use phase::{
    GuidedCatalogRead, GuidedCatalogSnapshot, GuidedPhaseInput, GuidedPhaseSelection, select_phase,
};
pub(crate) use work::{
    GuidedPreparationError, GuidedWork, load_guided_turn_work, work_scope_for_turn,
};

#[cfg(test)]
mod tests;
