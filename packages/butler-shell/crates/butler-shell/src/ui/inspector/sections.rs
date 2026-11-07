//! `SessionSections`, `useSessionSectionsModel`, `PendingAskRows`, `SubtaskRows`,
//! `SubtaskWorkerRows` and `SubtaskMark`.
use gpui::{AnyElement, App, IntoElement as _, Window};

use super::InspectorCtx;

/// The session sections of the inspector.
pub(crate) fn session_sections(
    ctx: &InspectorCtx<'_>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let _ = (
        super::order::step_order_section,
        super::order::epic_inspector,
        super::session_misc::browser_section,
        super::session_misc::context_compact,
        super::session_misc::session_info_actions,
    );
    let _ = (ctx, window, cx);
    gpui::Empty.into_any_element()
}
