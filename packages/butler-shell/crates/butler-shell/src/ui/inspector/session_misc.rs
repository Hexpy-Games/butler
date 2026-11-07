//! `BrowserSection`, `ContextCompact` and `SessionInfoActions`.
use gpui::{AnyElement, App, IntoElement as _, Window};

use super::InspectorCtx;

/// The browser section; `None` when the session has no browser.
pub(crate) fn browser_section(
    ctx: &InspectorCtx<'_>,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let _ = (ctx, window, cx);
    None
}

/// The compact context usage; `None` when there is nothing to show.
pub(crate) fn context_compact(
    ctx: &InspectorCtx<'_>,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let _ = (ctx, window, cx);
    None
}

/// The session actions row.
pub(crate) fn session_info_actions(
    ctx: &InspectorCtx<'_>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let _ = (ctx, window, cx);
    gpui::Empty.into_any_element()
}
