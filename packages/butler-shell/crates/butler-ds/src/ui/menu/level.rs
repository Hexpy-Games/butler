//! One level of a menu (the root or a submenu), flattened from its entries: the rows in order,
//! with every selectable row numbered. Groups vanish; a radio group becomes its items.
use std::rc::Rc;

use gpui::SharedString;

use super::entry::{Action, Checked, Entry, RadioGroup, Variant};
use crate::ui::Icon;

/// The check or minus a checkbox or radio item draws at its end when it is on.
#[derive(Clone, Copy)]
pub(super) struct Indicator {
    pub shown: bool,
    pub mixed: bool,
}

pub(super) enum Kind {
    Item {
        action: Action,
        indicator: Option<Indicator>,
    },
    Sub(Rc<Level>),
}

/// A row the highlight can land on.
pub(super) struct Selectable {
    pub idx: usize,
    pub label: SharedString,
    pub icon: Option<Icon>,
    pub shortcut: Option<SharedString>,
    /// Secondary lines under the label (each wraps anywhere).
    pub description: Vec<SharedString>,
    pub variant: Variant,
    pub disabled: bool,
    pub kind: Kind,
}

pub(super) enum Row {
    Item(Selectable),
    Label(SharedString),
    Separator,
}

#[derive(Default)]
pub(super) struct Level {
    pub rows: Vec<Row>,
}

impl Level {
    pub(super) fn flatten(entries: Vec<Entry>) -> Self {
        let mut level = Self::default();
        level.extend(entries);
        level
    }

    fn next_idx(&self) -> usize {
        self.rows
            .iter()
            .filter(|row| matches!(row, Row::Item(_)))
            .count()
    }

    fn selectable_row(&self, label: SharedString, disabled: bool, kind: Kind) -> Selectable {
        Selectable {
            idx: self.next_idx(),
            label,
            icon: None,
            shortcut: None,
            description: Vec::new(),
            variant: Variant::Default,
            disabled,
            kind,
        }
    }

    fn push_item(&mut self, label: SharedString, disabled: bool, kind: Kind) {
        let row = self.selectable_row(label, disabled, kind);
        self.rows.push(Row::Item(row));
    }

    fn extend(&mut self, entries: Vec<Entry>) {
        for entry in entries {
            match entry {
                Entry::Item(item) => {
                    let kind = Kind::Item {
                        action: item.action(),
                        indicator: None,
                    };
                    let mut row = self.selectable_row(item.label.clone(), item.disabled, kind);
                    row.icon = item.icon;
                    row.shortcut = item.shortcut;
                    row.description = item.description;
                    row.variant = item.variant;
                    self.rows.push(Row::Item(row));
                }
                Entry::Checkbox(item) => {
                    let indicator = Indicator {
                        shown: item.checked != Checked::Off,
                        mixed: item.checked == Checked::Mixed,
                    };
                    let kind = Kind::Item {
                        action: item.action(),
                        indicator: Some(indicator),
                    };
                    self.push_item(item.label, item.disabled, kind);
                }
                Entry::Radio(group) => self.extend_radio(group),
                Entry::Label(text) => self.rows.push(Row::Label(text)),
                Entry::Separator => self.rows.push(Row::Separator),
                Entry::Group(group) => self.extend(group.entries),
                Entry::Sub(sub) => {
                    let level = Rc::new(Self::flatten(sub.entries));
                    let mut row = self.selectable_row(sub.label, sub.disabled, Kind::Sub(level));
                    row.icon = sub.icon;
                    self.rows.push(Row::Item(row));
                }
            }
        }
    }

    fn extend_radio(&mut self, group: RadioGroup) {
        for item in group.items {
            let shown = item.value == group.value;
            let (change, value) = (group.on_change.clone(), item.value);
            let action: Action = Rc::new(move |window, cx| {
                if let Some(change) = &change {
                    change(value.clone(), window, cx);
                }
                true
            });
            let indicator = Some(Indicator {
                shown,
                mixed: false,
            });
            self.push_item(item.label, item.disabled, Kind::Item { action, indicator });
        }
    }

    /// The selectable rows in order; a row's `idx` is its place here.
    pub(super) fn selectable(&self) -> Vec<&Selectable> {
        self.rows
            .iter()
            .filter_map(|row| match row {
                Row::Item(item) => Some(item),
                _ => None,
            })
            .collect()
    }

    pub(super) fn get(&self, idx: usize) -> Option<&Selectable> {
        self.selectable().get(idx).copied()
    }

    /// Follows `path` (the open submenus, one trigger index per level) down from this level.
    pub(super) fn at(self: &Rc<Self>, path: &[usize]) -> Option<Rc<Self>> {
        let mut level = self.clone();
        for idx in path {
            let next = match &level.get(*idx)?.kind {
                Kind::Sub(sub) => sub.clone(),
                Kind::Item { .. } => return None,
            };
            level = next;
        }
        Some(level)
    }
}
