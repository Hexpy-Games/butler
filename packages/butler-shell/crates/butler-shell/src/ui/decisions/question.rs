//! the question panel (useComposerQuestion).
use gpui::{AnyElement, App, Window};

use super::DecisionCtx;

/// the question panel (useComposerQuestion); `None` when this session has nothing for it.
pub(crate) fn question_surface(
    ctx: DecisionCtx<'_>,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let _ = (ctx, window, cx);
    None
}
