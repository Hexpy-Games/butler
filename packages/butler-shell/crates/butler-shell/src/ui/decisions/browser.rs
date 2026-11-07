//! ComposerBrowserHandoffSurface.
use gpui::{AnyElement, App, Window};

use super::DecisionCtx;

/// ComposerBrowserHandoffSurface; `None` when this session has nothing for it.
pub(crate) fn browser_surface(
    ctx: DecisionCtx<'_>,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let _ = (ctx, window, cx);
    None
}
