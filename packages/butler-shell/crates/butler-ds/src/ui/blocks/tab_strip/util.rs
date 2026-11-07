//! Small helpers of the strip: element ids, the hover listener and the resting tab stop.
use gpui::{App, ElementId, Entity, SharedString, Window};

use super::model::{Group, Stop, chip_key, locate, tab_key};

pub(super) fn child_id(id: &ElementId, key: &str) -> ElementId {
    ElementId::from((id.clone(), SharedString::from(key.to_owned())))
}

/// Sets the hovered stop while the pointer is on it (the divider beside it steps aside).
pub(super) fn hover_listener(
    state: Entity<Option<SharedString>>,
    key: SharedString,
) -> impl Fn(&bool, &mut Window, &mut App) + 'static {
    move |on, _, cx| {
        state.update(cx, |hovered, cx| {
            let here = hovered.as_ref() == Some(&key);
            if *on && !here {
                *hovered = Some(key.clone());
                cx.notify();
            } else if !*on && here {
                *hovered = None;
                cx.notify();
            }
        });
    }
}

/// The roving tab stop when focus is outside: the active tab (or its folded title), else the
/// first stop.
pub(super) fn resting(
    groups: &[Group],
    list: &[Stop],
    active: Option<&SharedString>,
) -> Option<SharedString> {
    let has = |key: &SharedString| list.iter().any(|stop| &stop.key() == key);
    if let Some((group, _, tab)) = active.and_then(|id| locate(groups, id)) {
        let (tab, chip) = (tab_key(&tab.id), chip_key(&groups[group].id));
        if has(&tab) {
            return Some(tab);
        }
        if has(&chip) {
            return Some(chip);
        }
    }
    list.first().map(Stop::key)
}
