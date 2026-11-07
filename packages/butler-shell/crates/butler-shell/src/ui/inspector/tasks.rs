//! `TasksPanel`, `TaskGraphView`, `TaskNodeDetail`, `taskGraphPresentation` and `useTaskGraphClock`.
use gpui::{AnyElement, App, IntoElement as _, Window};

use super::InspectorCtx;

/// The tasks panel with the session's task graph.
pub(crate) fn tasks_panel(ctx: &InspectorCtx<'_>, window: &mut Window, cx: &mut App) -> AnyElement {
    let _ = (ctx, window, cx);
    gpui::Empty.into_any_element()
}
