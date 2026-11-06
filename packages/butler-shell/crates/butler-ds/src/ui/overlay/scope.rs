//! The focus scope of an overlay (Radix `FocusScope`): on open it remembers where focus was and,
//! when asked, moves focus to the first tabbable inside (else the container); on close it can put
//! focus back; trapped, Tab and Shift+Tab wrap inside instead of leaving. A non-modal popover
//! asks for none of it (the DS prevents auto-focus and restore); menus and Select do.
use gpui::{App, FocusHandle, WeakFocusHandle, Window};

/// How many steps a backward wrap may walk to find the last tabbable of the scope.
const WRAP_LIMIT: usize = 512;

pub struct Scope {
    /// The container's handle: put it on the layer's content with `track_focus`.
    pub handle: FocusHandle,
    previous: Option<WeakFocusHandle>,
    active: bool,
}

impl Scope {
    pub fn new(cx: &mut App) -> Self {
        Self {
            handle: cx.focus_handle().tab_stop(false),
            previous: None,
            active: false,
        }
    }

    /// Follows `open` for this frame. Opening remembers the focused element and, with
    /// `auto_focus`, focuses into the scope; closing, with `restore`, focuses the remembered
    /// element again.
    pub fn sync(
        &mut self,
        open: bool,
        auto_focus: bool,
        restore: bool,
        window: &mut Window,
        cx: &mut App,
    ) {
        if open && !self.active {
            self.active = true;
            self.previous = window.focused(cx).map(|focus| focus.downgrade());
            if auto_focus {
                let handle = self.handle.clone();
                window.defer(cx, move |window, cx| focus_first(&handle, window, cx));
            }
        } else if !open && self.active {
            self.active = false;
            let previous = self.previous.take().and_then(|weak| weak.upgrade());
            if let (true, Some(previous)) = (restore, previous) {
                window.defer(cx, move |window, cx| previous.focus(window, cx));
            }
        }
    }

    /// Moves focus to the first tabbable of the scope, else the container. Call it once the scope's
    /// content has been drawn (the tab stops come from the frame before).
    pub fn focus_into(&self, window: &mut Window, cx: &mut App) {
        focus_first(&self.handle, window, cx);
    }

    /// Tab or Shift+Tab inside a trapped scope: moves focus one tab stop and, past either end,
    /// wraps to the other. False when focus is not inside (nothing to trap).
    pub fn trap_tab(&self, backward: bool, window: &mut Window, cx: &mut App) -> bool {
        if !self.handle.contains_focused(window, cx) {
            return false;
        }
        if backward {
            window.focus_prev(cx);
        } else {
            window.focus_next(cx);
        }
        if self.handle.contains_focused(window, cx) {
            return true;
        }
        if backward {
            focus_last(&self.handle, window, cx);
        } else {
            focus_first(&self.handle, window, cx);
        }
        true
    }
}

/// The first tabbable of the scope, else the container.
fn focus_first(handle: &FocusHandle, window: &mut Window, cx: &mut App) {
    handle.focus(window, cx);
    window.focus_next(cx);
    if !handle.contains_focused(window, cx) {
        handle.focus(window, cx);
    }
}

/// The last tabbable of the scope: walks forward from the container until focus leaves, then
/// steps back once.
fn focus_last(handle: &FocusHandle, window: &mut Window, cx: &mut App) {
    handle.focus(window, cx);
    for _ in 0..WRAP_LIMIT {
        window.focus_next(cx);
        if !handle.contains_focused(window, cx) {
            window.focus_prev(cx);
            return;
        }
    }
}
