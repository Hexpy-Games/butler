//! The decision surfaces of the conversation (`ConversationRequestPortal`): the authority card, the
//! question panel, the plan decision, the browser handoff and the canon panels, all on DS blocks.
//! The transcript shows them (`Placement::Conversation`); the composer keeps its input below.
//! They replace `composer/approval.rs` and `shell/modify.rs` (owner decision 1).
mod authority;
mod browser;
mod canon;
mod plan;
mod question;

use butler_ds::ui::blocks::composer_panel::Placement;
use gpui::{AnyElement, App, Window};

use crate::ui::source::wire::SessionView;

pub(crate) use authority::{initiated_approval, on_authority_changed};
pub(crate) use browser::browser_step_still;
pub(crate) use canon::InitiatedHooks;
pub(crate) use canon::{
    canon_proposal_cards, initiated_approval_line, initiated_panels, turn_decision_row,
};
pub(crate) use plan::{
    PlanBridge, plan_document_card, plan_instruction, set_plan_bridge, set_plan_gate,
    show_plan_decision, submit_plan_instruction,
};
pub(crate) use question::on_question_answered;

/// What every decision unit reads while one session renders.
#[derive(Clone, Copy)]
pub(crate) struct DecisionCtx<'a> {
    pub(crate) view: &'a SessionView,
}

/// `ConversationRequestPortal`: the decision of the open session, in `placement`; `None` when
/// this session has nothing for it. The question panel stays open in every state.
pub(crate) fn decision_surface(
    ctx: DecisionCtx<'_>,
    placement: Placement,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    // ComposerAuthorityDecisionSurface hands browser handoff requests to their own panel.
    browser::browser_surface(ctx, placement, window, cx)
        .or_else(|| authority::authority_surface(ctx, placement, window, cx))
        .or_else(|| question::question_surface(ctx, placement, window, cx))
        // The plan surface yields while a question exists.
        .or_else(|| {
            if question::question_pending(ctx) {
                None
            } else {
                plan::plan_surface(ctx, placement, window, cx)
            }
        })
}

/// `useConversationDecision`'s `active`: a decision waits, so the composer stays expanded.
pub(crate) fn decision_active(ctx: DecisionCtx<'_>, cx: &App) -> bool {
    authority::has_request(ctx.view) || question::question_pending(ctx) || plan::waiting(ctx, cx)
}

/// `useComposerDecision.ts`: Send waits for authority or the first pending question.
pub(crate) fn send_blocked(ctx: DecisionCtx<'_>) -> bool {
    authority::has_request(ctx.view) || question::question_waiting(ctx)
}
