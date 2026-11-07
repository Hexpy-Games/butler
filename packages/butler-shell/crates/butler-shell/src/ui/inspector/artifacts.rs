//! `ArtifactsPanel` and `AutomationTargetsPanel`.
use gpui::{AnyElement, App, IntoElement as _, Window};

use super::InspectorCtx;

/// The session's artifacts.
pub(crate) fn artifacts_panel(
    ctx: &InspectorCtx<'_>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let _ = (ctx, window, cx);
    gpui::Empty.into_any_element()
}

/// The automation targets; `None` when the session has none.
pub(crate) fn automation_targets_panel(
    ctx: &InspectorCtx<'_>,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let _ = (ctx, window, cx);
    None
}
