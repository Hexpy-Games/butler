//! The keys of an open menu (Radix `MenuContent`, `MenuItem` and `MenuSub*` key handlers):
//! navigation and typeahead through the runtime, Enter and Space to select, Right to open a
//! submenu and Left to close one, and Tab prevented. Escape is the layer stack's.
use std::rc::Rc;

use gpui::{App, KeyDownEvent, Keystroke, Window};

use super::Menu;
use super::level::{Kind, Level};
use super::runtime::first_enabled;
use crate::ui::overlay::roving;

/// The character a key types: the platform's `key_char`, else the key itself when it is one
/// character, Space included.
fn typed(keystroke: &Keystroke) -> Option<String> {
    if let Some(text) = &keystroke.key_char {
        return Some(text.clone());
    }
    match keystroke.key.as_str() {
        "space" => Some(" ".to_owned()),
        key if key.chars().count() == 1 => Some(key.to_owned()),
        _ => None,
    }
}

/// Handles a key down inside the menu; true when it was used.
pub(super) fn handle(
    menu: &Menu,
    root: &Rc<Level>,
    event: &KeyDownEvent,
    window: &mut Window,
    cx: &mut App,
) -> bool {
    let keystroke = &event.keystroke;
    let key = keystroke.key.as_str();
    let mods = keystroke.modifiers;
    let modified = mods.control || mods.alt || mods.platform || mods.shift;
    let now = cx.background_executor().now();
    let (lvl, path, current, searching) = {
        let rt = menu.rt.read(cx);
        let lvl = rt.focus_level;
        let path = rt
            .path
            .get(..lvl)
            .map(<[usize]>::to_vec)
            .unwrap_or_default();
        (lvl, path, rt.highlight(lvl), rt.searching(now))
    };
    let Some(level) = root.at(&path) else {
        return false;
    };
    let mut handled = match key {
        "tab" => {
            if menu.modal {
                // A trapped scope keeps Tab inside it.
                menu.scope.update(cx, |scope, cx| {
                    scope.trap_tab(mods.shift, window, cx);
                });
            }
            true
        }
        "left" if lvl > 0 => menu.rt.update(cx, |rt, cx| {
            cx.notify();
            rt.close_focused_sub()
        }),
        "enter" | "space" | "right" if !(searching && key == "space") => {
            activate(menu, &level, lvl, current, key, window, cx)
        }
        _ => menu.rt.update(cx, |rt, cx| {
            let used = rt.navigate(&level, key, modified);
            if used {
                cx.notify();
            }
            used
        }),
    };
    if let Some(text) = typed(keystroke)
        && roving::is_search_key(&text, mods.control, mods.alt, mods.platform)
    {
        menu.rt.update(cx, |rt, cx| {
            rt.search(&level, &text, now);
            cx.notify();
        });
        handled = true;
    }
    handled
}

/// Enter or Space on the highlighted row selects it; Right (and Enter and Space) on a submenu
/// trigger opens the submenu and moves focus into it.
fn activate(
    menu: &Menu,
    level: &Level,
    lvl: usize,
    current: Option<usize>,
    key: &str,
    window: &mut Window,
    cx: &mut App,
) -> bool {
    let Some(row) = current
        .and_then(|idx| level.get(idx))
        .filter(|row| !row.disabled)
    else {
        return false;
    };
    match &row.kind {
        Kind::Sub(sub) => {
            let first = first_enabled(sub);
            menu.rt.update(cx, |rt, cx| {
                rt.open_sub(lvl, row.idx, first, true);
                cx.notify();
            });
            true
        }
        Kind::Item { action, .. } if key != "right" => {
            if action(window, cx) {
                menu.close(window, cx);
            }
            true
        }
        Kind::Item { .. } => false,
    }
}
