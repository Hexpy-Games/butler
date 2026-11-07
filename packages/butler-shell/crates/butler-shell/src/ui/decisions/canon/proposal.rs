//! `canon/CanonProposalCard` with its Changes, Fact and Project parts.
use gpui::{AnyElement, App, IntoElement as _, Window};

use crate::ui::decisions::DecisionCtx;
use crate::ui::source::wire::CanonProposalAnchor;

/// One canon proposal card.
pub(crate) fn canon_proposal_card(
    ctx: DecisionCtx<'_>,
    anchor: &CanonProposalAnchor,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let _ = (ctx, anchor, window, cx);
    gpui::Empty.into_any_element()
}
