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

pub(crate) use plan::plan_document_message;

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
    let _ = (
        authority::authority_surface,
        question::question_surface,
        plan::plan_surface,
        browser::browser_surface,
        canon::canon_panels,
    );
    let _ = (ctx, window, cx);
    None
}
