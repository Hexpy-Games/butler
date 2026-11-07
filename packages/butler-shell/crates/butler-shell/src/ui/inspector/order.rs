//! `StepOrderSection`, `canonOrderModel` and `canon/EpicInspector`.
use gpui::{AnyElement, App, Window};

use super::InspectorCtx;

/// The step order section; `None` when the session has no ordered steps.
pub(crate) fn step_order_section(
    ctx: &InspectorCtx<'_>,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let _ = (ctx, window, cx);
    None
}

/// The epic inspector; `None` when the session belongs to no epic.
pub(crate) fn epic_inspector(
    ctx: &InspectorCtx<'_>,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let _ = (ctx, window, cx);
    None
}
