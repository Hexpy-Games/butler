//! The content of a menu as data (the children of DropdownMenuContent and ContextMenuContent):
//! Item, CheckboxItem, RadioGroup with RadioItem, Label, Separator, Group and Sub. A menu is
//! flattened from these on every render, so the key handler, typeahead and highlight all see
//! the same items in the same order (see `level`).
use std::rc::Rc;

use gpui::{App, SharedString, Window};

use crate::ui::Icon;

/// `variant` of an item.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Variant {
    #[default]
    Default,
    Destructive,
}

/// `checked` of a checkbox item: `indeterminate` shows a minus instead of the check.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Checked {
    Off,
    On,
    Mixed,
}

impl From<bool> for Checked {
    fn from(on: bool) -> Self {
        if on { Self::On } else { Self::Off }
    }
}

/// What selecting an item does; it returns whether the menu closes.
pub(super) type Action = Rc<dyn Fn(&mut Window, &mut App) -> bool>;
type Handler = Rc<dyn Fn(&mut Window, &mut App)>;
type CheckedChange = Rc<dyn Fn(bool, &mut Window, &mut App)>;
type ValueChange = Rc<dyn Fn(SharedString, &mut Window, &mut App)>;

fn action(handler: Option<Handler>, keep_open: bool) -> Action {
    Rc::new(move |window, cx| {
        if let Some(handler) = &handler {
            handler(window, cx);
        }
        !keep_open
    })
}

/// A menu item (`onSelect`, `disabled`, `variant`); selecting it runs the handler and closes
/// the menu unless [`Item::keep_open`] (Radix: `preventDefault` in `onSelect`).
pub struct Item {
    pub(super) label: SharedString,
    pub(super) icon: Option<Icon>,
    pub(super) shortcut: Option<SharedString>,
    pub(super) description: Vec<SharedString>,
    pub(super) variant: Variant,
    pub(super) disabled: bool,
    keep_open: bool,
    on_select: Option<Handler>,
}

impl Item {
    pub fn new(label: impl Into<SharedString>) -> Self {
        Self {
            label: label.into(),
            icon: None,
            shortcut: None,
            description: Vec::new(),
            variant: Variant::Default,
            disabled: false,
            keep_open: false,
            on_select: None,
        }
    }

    /// A 14px glyph before the label.
    pub fn icon(mut self, icon: Icon) -> Self {
        self.icon = Some(icon);
        self
    }

    /// `DropdownMenuShortcut`: tertiary text at the end of the row.
    pub fn shortcut(mut self, shortcut: impl Into<SharedString>) -> Self {
        self.shortcut = Some(shortcut.into());
        self
    }

    /// Secondary lines under the label, in secondary caption text that wraps anywhere.
    pub fn description(mut self, lines: impl IntoIterator<Item = SharedString>) -> Self {
        self.description = lines.into_iter().collect();
        self
    }

    pub fn variant(mut self, variant: Variant) -> Self {
        self.variant = variant;
        self
    }

    pub fn disabled(mut self) -> Self {
        self.disabled = true;
        self
    }

    pub fn keep_open(mut self) -> Self {
        self.keep_open = true;
        self
    }

    pub fn on_select(mut self, handler: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_select = Some(Rc::new(handler));
        self
    }

    pub(super) fn action(&self) -> Action {
        action(self.on_select.clone(), self.keep_open)
    }
}

/// A checkbox item: selecting it asks for the opposite (`true` when indeterminate).
pub struct CheckboxItem {
    pub(super) label: SharedString,
    pub(super) checked: Checked,
    pub(super) disabled: bool,
    on_change: Option<CheckedChange>,
}

impl CheckboxItem {
    pub fn new(label: impl Into<SharedString>, checked: impl Into<Checked>) -> Self {
        Self {
            label: label.into(),
            checked: checked.into(),
            disabled: false,
            on_change: None,
        }
    }

    pub fn disabled(mut self) -> Self {
        self.disabled = true;
        self
    }

    pub fn on_checked_change(
        mut self,
        handler: impl Fn(bool, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_change = Some(Rc::new(handler));
        self
    }

    pub(super) fn action(&self) -> Action {
        let next = self.checked != Checked::On;
        let on_change = self.on_change.clone();
        Rc::new(move |window, cx| {
            if let Some(on_change) = &on_change {
                on_change(next, window, cx);
            }
            true
        })
    }
}

/// One option of a [`RadioGroup`].
pub struct RadioItem {
    pub(super) value: SharedString,
    pub(super) label: SharedString,
    pub(super) disabled: bool,
}

impl RadioItem {
    pub fn new(value: impl Into<SharedString>, label: impl Into<SharedString>) -> Self {
        Self {
            value: value.into(),
            label: label.into(),
            disabled: false,
        }
    }

    pub fn disabled(mut self) -> Self {
        self.disabled = true;
        self
    }
}

/// A group of radio items sharing one value.
pub struct RadioGroup {
    pub(super) value: SharedString,
    pub(super) items: Vec<RadioItem>,
    pub(super) on_change: Option<ValueChange>,
}

impl RadioGroup {
    pub fn new(value: impl Into<SharedString>) -> Self {
        Self {
            value: value.into(),
            items: Vec::new(),
            on_change: None,
        }
    }

    pub fn item(mut self, item: RadioItem) -> Self {
        self.items.push(item);
        self
    }

    pub fn on_value_change(
        mut self,
        handler: impl Fn(SharedString, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_change = Some(Rc::new(handler));
        self
    }
}

/// A role=group wrapper: it draws nothing of its own.
#[derive(Default)]
pub struct Group {
    pub(super) entries: Vec<Entry>,
}

impl Group {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn child(mut self, entry: impl Into<Entry>) -> Self {
        self.entries.push(entry.into());
        self
    }
}

/// A submenu: a trigger row that opens its own surface beside it.
pub struct Sub {
    pub(super) label: SharedString,
    pub(super) icon: Option<Icon>,
    pub(super) disabled: bool,
    pub(super) entries: Vec<Entry>,
}

impl Sub {
    pub fn new(label: impl Into<SharedString>) -> Self {
        Self {
            label: label.into(),
            icon: None,
            disabled: false,
            entries: Vec::new(),
        }
    }

    pub fn icon(mut self, icon: Icon) -> Self {
        self.icon = Some(icon);
        self
    }

    pub fn disabled(mut self) -> Self {
        self.disabled = true;
        self
    }

    pub fn child(mut self, entry: impl Into<Entry>) -> Self {
        self.entries.push(entry.into());
        self
    }
}

/// A child of a menu.
pub enum Entry {
    Item(Item),
    Checkbox(CheckboxItem),
    Radio(RadioGroup),
    Label(SharedString),
    Separator,
    Group(Group),
    Sub(Sub),
}

macro_rules! entry_from {
    ($($ty:ident => $variant:ident),* $(,)?) => {
        $(impl From<$ty> for Entry {
            fn from(value: $ty) -> Self {
                Self::$variant(value)
            }
        })*
    };
}

entry_from!(Item => Item, CheckboxItem => Checkbox, RadioGroup => Radio, Group => Group, Sub => Sub);

impl Entry {
    /// `DropdownMenuLabel`.
    pub fn label(text: impl Into<SharedString>) -> Self {
        Self::Label(text.into())
    }

    /// `DropdownMenuSeparator`.
    pub fn separator() -> Self {
        Self::Separator
    }
}
