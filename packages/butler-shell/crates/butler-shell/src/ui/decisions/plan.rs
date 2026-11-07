//! `ComposerPlanDecisionSurface`, `ComposerPlanInstructionContext` and `PlanDocumentMessage`.
use gpui::{AnyElement, App, Window};

use super::DecisionCtx;

/// The plan decision; `None` when no plan waits for a decision.
pub(crate) fn plan_surface(
    ctx: DecisionCtx<'_>,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let _ = (ctx, window, cx);
    None
}

/// `PlanDocumentMessage`: the plan document shown in the transcript.
pub(crate) fn plan_document_message(
    ctx: DecisionCtx<'_>,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let _ = (ctx, window, cx);
    None
}
