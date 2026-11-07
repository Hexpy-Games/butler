//! ComposerAuthorityDecisionSurface.
use gpui::{AnyElement, App, Window};

use super::DecisionCtx;

/// ComposerAuthorityDecisionSurface; `None` when this session has nothing for it.
pub(crate) fn authority_surface(
    ctx: DecisionCtx<'_>,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let _ = (ctx, window, cx);
    None
}
