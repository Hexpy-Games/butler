//! The keys of an open Select (Radix `SelectContentImpl` and `SelectItem` key handlers): Up,
//! Down, Home and End move the highlight, typeahead searches the items' text, Enter and Space
//! choose the highlighted item (a Space while a search runs belongs to the search), Tab is
//! prevented. Escape is the layer stack's.
use std::rc::Rc;

use gpui::{App, KeyDownEvent, Window};

use super::Select;
use super::entry::Row;
use super::surface::position_of;
use crate::ui::overlay::roving;

/// The character a key types: the platform's `key_char`, else the key itself when it is one
/// character, Space included.
pub(super) fn typed(keystroke: &gpui::Keystroke) -> Option<String> {
    if let Some(text) = &keystroke.key_char {
        return Some(text.clone());
    }
    match keystroke.key.as_str() {
        "space" => Some(" ".to_owned()),
        key if key.chars().count() == 1 => Some(key.to_owned()),
        _ => None,
    }
}

/// The enabled items: their index and label.
pub(super) fn enabled(rows: &[Row]) -> Vec<(usize, &str)> {
    rows.iter()
        .filter_map(|row| match row {
            Row::Item {
                idx,
                label,
                disabled: false,
                ..
            } => Some((*idx, label.as_ref())),
            _ => None,
        })
        .collect()
}

/// Handles a key down inside the list; true when it was used.
pub(super) fn handle(
    sel: &Select,
    rows: &Rc<Vec<Row>>,
    event: &KeyDownEvent,
    window: &mut Window,
    cx: &mut App,
) -> bool {
    let keystroke = &event.keystroke;
    let key = keystroke.key.as_str();
    let mods = keystroke.modifiers;
    let now = cx.background_executor().now();
    let (highlight, searching) = {
        let rt = sel.rt.read(cx);
        (rt.highlight, rt.searching(now))
    };
    let disabled: Vec<bool> = rows
        .iter()
        .filter_map(|row| match row {
            Row::Item { disabled, .. } => Some(*disabled),
            _ => None,
        })
        .collect();
    let mut handled = match key {
        "tab" => {
            // Focus is trapped in the open list: Tab stays inside it.
            sel.scope.update(cx, |scope, cx| {
                scope.trap_tab(mods.shift, window, cx);
            });
            true
        }
        "enter" | "space" if !(searching && key == "space") => {
            choose(sel, rows, highlight, window, cx)
        }
        "up" | "down" | "home" | "end" => {
            sel.rt.update(cx, |rt, cx| {
                rt.navigate(key, &disabled);
                if let Some(at) = rt.highlight.and_then(|idx| position_of(rows, idx)) {
                    rt.scroll.scroll_to_item(at);
                }
                cx.notify();
            });
            true
        }
        _ => false,
    };
    if let Some(text) = typed(keystroke)
        && roving::is_search_key(&text, mods.control, mods.alt, mods.platform)
    {
        let labels = enabled(rows);
        sel.rt.update(cx, |rt, cx| {
            rt.search(&text, now, &labels);
            if let Some(at) = rt.highlight.and_then(|idx| position_of(rows, idx)) {
                rt.scroll.scroll_to_item(at);
            }
            cx.notify();
        });
        handled = true;
    }
    handled
}

fn choose(
    sel: &Select,
    rows: &[Row],
    highlight: Option<usize>,
    window: &mut Window,
    cx: &mut App,
) -> bool {
    let value = rows.iter().find_map(|row| match row {
        Row::Item {
            idx,
            value,
            disabled: false,
            ..
        } if Some(*idx) == highlight => Some(value.clone()),
        _ => None,
    });
    match value {
        Some(value) => {
            sel.choose(value, window, cx);
            true
        }
        None => false,
    }
}
