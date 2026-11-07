//! Arrow-key navigation shared by the canvas and the lanes: each task slot tracks a focus handle
//! that contains its card's, so the key handler knows which task holds focus, and focus moves
//! along the tab order (the reading order of the tasks).
use gpui::{App, ElementId, FocusHandle, SharedString, Window};

/// A focus handle per task id, kept across frames.
pub(crate) fn handles(
    view: &ElementId,
    ids: &[SharedString],
    window: &mut Window,
    cx: &mut App,
) -> Vec<(SharedString, FocusHandle)> {
    ids.iter()
        .map(|id| {
            let key = (view.clone(), SharedString::from(format!("focus-{id}")));
            let state = window.use_keyed_state(key, cx, |_, cx| cx.focus_handle().tab_stop(false));
            (id.clone(), state.read(cx).clone())
        })
        .collect()
}

/// The task whose card holds focus.
pub(crate) fn focused(
    handles: &[(SharedString, FocusHandle)],
    window: &Window,
    cx: &App,
) -> Option<SharedString> {
    handles
        .iter()
        .find(|(_, handle)| handle.contains_focused(window, cx))
        .map(|(id, _)| id.clone())
}

/// Moves keyboard focus from the card of `from` to the card of `to`: one tab stop per task
/// between them in `order`.
pub(crate) fn move_focus(
    order: &[SharedString],
    (from, to): (&SharedString, &SharedString),
    window: &mut Window,
    cx: &mut App,
) {
    let at = |id: &SharedString| order.iter().position(|item| item == id);
    let (Some(a), Some(b)) = (at(from), at(to)) else {
        return;
    };
    for _ in 0..a.abs_diff(b) {
        if b > a {
            window.focus_next(cx);
        } else {
            window.focus_prev(cx);
        }
    }
}
