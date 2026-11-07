//! Roving focus for the strip (useTabStripNavigation.ts): arrows move across titles, tabs and
//! group new-tab buttons and wrap, Home and End jump, Delete and Backspace close the focused
//! tab, Cmd/Ctrl+Shift+arrows move it. Focus follows the tab through re-renders (its handle is
//! keyed by the tab).
use std::rc::Rc;

use gpui::{App, FocusHandle, KeyDownEvent, Window};

use super::model::{Group, NavKey, Stop, focus_after_close, locate, move_by_step, next_focus};
use super::{MoveHandler, Pick};

/// What the key handler acts on.
pub(super) struct Keys {
    pub(super) stops: Vec<(Stop, FocusHandle)>,
    pub(super) groups: Vec<Group>,
    pub(super) on_close: Option<Pick>,
    pub(super) on_move: Option<MoveHandler>,
}

fn nav_key(key: &str) -> Option<NavKey> {
    match key {
        "left" => Some(NavKey::Left),
        "right" => Some(NavKey::Right),
        "home" => Some(NavKey::Home),
        "end" => Some(NavKey::End),
        _ => None,
    }
}

pub(super) fn handler(keys: Keys) -> impl Fn(&KeyDownEvent, &mut Window, &mut App) + 'static {
    let keys = Rc::new(keys);
    move |event, window, cx| {
        let modifiers = event.keystroke.modifiers;
        if modifiers.alt {
            return;
        }
        let Some(here) = keys.stops.iter().position(|(_, h)| h.is_focused(window)) else {
            return;
        };
        let modified = modifiers.platform || modifiers.control;
        let key = event.keystroke.key.as_str();
        let stop = &keys.stops[here].0;
        let focus = |at: Option<usize>, window: &mut Window, cx: &mut App| {
            if let Some((_, handle)) = at.and_then(|at| keys.stops.get(at)) {
                window.focus(handle, cx);
            }
        };
        match (stop, key) {
            (Stop::Tab { tab, .. }, "left" | "right") if modified && modifiers.shift => {
                cx.stop_propagation();
                let moved =
                    keys.on_move
                        .as_ref()
                        .zip(move_by_step(&keys.groups, tab, key == "right"));
                if let Some((on_move, mv)) = moved {
                    on_move(&mv, window, cx);
                }
            }
            (_, "left" | "right" | "home" | "end") if !modified => {
                cx.stop_propagation();
                let target = nav_key(key).and_then(|nav| next_focus(keys.stops.len(), here, nav));
                focus(target, window, cx);
            }
            (Stop::Tab { tab, .. }, "delete" | "backspace") if !modified => {
                if locate(&keys.groups, tab).is_some_and(|(_, _, found)| !found.closable) {
                    return;
                }
                cx.stop_propagation();
                focus(focus_after_close(keys.stops.len(), here), window, cx);
                if let Some(close) = &keys.on_close {
                    close(tab, window, cx);
                }
            }
            _ => {}
        }
    }
}
