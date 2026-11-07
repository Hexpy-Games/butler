//! The decision surfaces in the composer slot (`ComposerInputSurface`): the authority card, the
//! question panel, the plan decision, the browser handoff and the canon panels, all on DS blocks.
//! They replace `composer/approval.rs` and `shell/modify.rs` (owner decision 1).
mod authority;
mod browser;
mod canon;
mod plan;
mod question;

use gpui::{AnyElement, App, Window};

use crate::ui::source::wire::SessionView;

pub(crate) use authority::on_authority_changed;
pub(crate) use browser::browser_step_still;
pub(crate) use canon::InitiatedHooks;
pub(crate) use canon::{canon_proposal_cards, initiated_panels, turn_decision_row};
pub(crate) use plan::{
    PlanBridge, plan_document_card, plan_instruction, set_plan_bridge, set_plan_gate,
    show_plan_decision, submit_plan_instruction,
};
pub(crate) use question::{on_question_answered, question_attachment};

/// What every decision unit reads while one session renders.
#[derive(Clone, Copy)]
pub(crate) struct DecisionCtx<'a> {
    pub(crate) view: &'a SessionView,
}

/// `ComposerInputSurface`: the surface that takes the composer input's place, if any.
pub(crate) fn decision_surface(
    ctx: DecisionCtx<'_>,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    // ComposerAuthorityDecisionSurface hands browser handoff requests to their own panel.
    browser::browser_surface(ctx, window, cx)
        .or_else(|| authority::authority_surface(ctx, window, cx))
        .or_else(|| question::question_surface(ctx, window, cx))
        // The plan surface yields while a question exists, collapsed or not.
        .or_else(|| {
            if question::question_pending(ctx) {
                None
            } else {
                plan::plan_surface(ctx, window, cx)
            }
        })
}
