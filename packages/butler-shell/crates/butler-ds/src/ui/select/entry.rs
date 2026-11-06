//! The content of a Select as data: SelectItem, SelectLabel, SelectSeparator and SelectGroup,
//! flattened into the rows of the list on every render.
use std::rc::Rc;

use gpui::{AnyElement, SharedString};

use crate::ui::overlay::Presentation;
use crate::ui::overlay::place::Align;
use crate::ui::overlay::theme::Theme;

/// `position`: item-aligned lays the list over the trigger so the selected item sits on the
/// value; popper places it below the trigger like a popover.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Position {
    #[default]
    ItemAligned,
    Popper,
}

pub(super) type Icon = Rc<dyn Fn() -> AnyElement>;

/// `SelectItem`: a value, its label and an optional 16px glyph slot outside the label (so
/// typeahead matches the label).
pub struct SelectItem {
    pub(super) value: SharedString,
    pub(super) label: SharedString,
    pub(super) icon: Option<Icon>,
    pub(super) disabled: bool,
}

impl SelectItem {
    pub fn new(value: impl Into<SharedString>, label: impl Into<SharedString>) -> Self {
        Self {
            value: value.into(),
            label: label.into(),
            icon: None,
            disabled: false,
        }
    }

    /// A decorative glyph before the label; the trigger shows it with the chosen value.
    pub fn icon(mut self, icon: impl Fn() -> AnyElement + 'static) -> Self {
        self.icon = Some(Rc::new(icon));
        self
    }

    pub fn disabled(mut self) -> Self {
        self.disabled = true;
        self
    }
}

/// `SelectGroup`: a role=group wrapper that draws nothing of its own.
#[derive(Default)]
pub struct SelectGroup {
    entries: Vec<Entry>,
}

impl SelectGroup {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn child(mut self, entry: impl Into<Entry>) -> Self {
        self.entries.push(entry.into());
        self
    }
}

/// A child of the list.
pub enum Entry {
    Item(SelectItem),
    Label(SharedString),
    Separator,
    Group(SelectGroup),
}

impl From<SelectItem> for Entry {
    fn from(item: SelectItem) -> Self {
        Self::Item(item)
    }
}

impl From<SelectGroup> for Entry {
    fn from(group: SelectGroup) -> Self {
        Self::Group(group)
    }
}

impl Entry {
    /// `SelectLabel`.
    pub fn label(text: impl Into<SharedString>) -> Self {
        Self::Label(text.into())
    }

    /// `SelectSeparator`.
    pub fn separator() -> Self {
        Self::Separator
    }
}

/// The props and children of `SelectContent`.
pub struct SelectContent {
    pub(super) position: Position,
    pub(super) align: Align,
    pub(super) presentation: Option<Presentation>,
    pub(super) theme: Option<Theme>,
    pub(super) entries: Vec<Entry>,
}

impl SelectContent {
    pub fn new() -> Self {
        Self {
            position: Position::ItemAligned,
            align: Align::Center,
            presentation: None,
            theme: None,
            entries: Vec::new(),
        }
    }

    /// Default `item-aligned`.
    pub fn position(mut self, position: Position) -> Self {
        self.position = position;
        self
    }

    /// Where the list sits along the trigger in popper position; default `center`.
    pub fn align(mut self, align: Align) -> Self {
        self.align = align;
        self
    }

    /// `auto | popover | sheet`: a BottomSheet below 768px, anchored above (the app default).
    pub fn presentation(mut self, presentation: Presentation) -> Self {
        self.presentation = Some(presentation);
        self
    }

    /// The theme of the layer; by default the trigger's.
    pub fn theme(mut self, theme: Theme) -> Self {
        self.theme = Some(theme);
        self
    }

    pub fn child(mut self, entry: impl Into<Entry>) -> Self {
        self.entries.push(entry.into());
        self
    }

    /// The value, label and glyph of every item in order.
    pub(super) fn rows(&self) -> Vec<Row> {
        let mut rows = Vec::new();
        flatten(&self.entries, &mut rows);
        rows
    }
}

impl Default for SelectContent {
    fn default() -> Self {
        Self::new()
    }
}

/// One row of the list.
#[derive(Clone)]
pub(super) enum Row {
    Item {
        idx: usize,
        value: SharedString,
        label: SharedString,
        icon: Option<Icon>,
        disabled: bool,
    },
    Label(SharedString),
    Separator,
}

fn flatten(entries: &[Entry], rows: &mut Vec<Row>) {
    for entry in entries {
        match entry {
            Entry::Item(item) => {
                let idx = rows
                    .iter()
                    .filter(|row| matches!(row, Row::Item { .. }))
                    .count();
                rows.push(Row::Item {
                    idx,
                    value: item.value.clone(),
                    label: item.label.clone(),
                    icon: item.icon.clone(),
                    disabled: item.disabled,
                });
            }
            Entry::Label(text) => rows.push(Row::Label(text.clone())),
            Entry::Separator => rows.push(Row::Separator),
            Entry::Group(group) => flatten(&group.entries, rows),
        }
    }
}
