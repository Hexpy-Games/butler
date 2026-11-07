//! The conversation inspector (ConversationShell aside on InspectorPanel): the session sections,
//! the task graph and the artifacts.
mod artifacts;
mod order;
mod sections;
mod session_misc;
mod tasks;

use std::rc::Rc;

use gpui::{AnyElement, App, IntoElement as _, Window};

use crate::ui::source::wire::SessionView;

/// What every inspector unit reads while one session renders.
#[derive(Clone)]
pub(crate) struct InspectorCtx<'a> {
    pub(crate) view: &'a SessionView,
    /// The same view as a shared handle, for state kept between frames.
    pub(crate) shared: Rc<SessionView>,
}

/// The inspector's content for the open session.
pub(crate) fn inspector(ctx: &InspectorCtx<'_>, window: &mut Window, cx: &mut App) -> AnyElement {
    let _ = (
        sections::session_sections,
        tasks::tasks_panel,
        artifacts::artifacts_panel,
        artifacts::automation_targets_panel,
    );
    let _ = (ctx, window, cx);
    gpui::Empty.into_any_element()
}
