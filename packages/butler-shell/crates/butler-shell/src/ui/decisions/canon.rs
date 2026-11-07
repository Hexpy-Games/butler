//! `CanonDecisionPanels`, `InitiatedPanels`, `InitiatedApprovalLine`, `useInitiatedDecision`,
//! `TurnDecisionRow` and `WorkDecisionBody`.
mod proposal;

use gpui::{AnyElement, App, Window};

use super::DecisionCtx;

/// The canon and initiated-work panels; `None` when nothing waits.
pub(crate) fn canon_panels(
    ctx: DecisionCtx<'_>,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let _ = proposal::canon_proposal_card;
    let _ = (ctx, window, cx);
    None
}
