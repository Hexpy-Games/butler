//! DS OverflowActionMenu (OverflowActionMenu.tsx): a "more" icon button that opens a DropdownMenu
//! of row actions, end-aligned and 8px below the trigger. The trigger shows pressed while the
//! menu is open; `open` and `on_open_change` control it for row-context triggers.
use std::rc::Rc;

use gpui::{
    App, ElementId, IntoElement, ParentElement as _, RenderOnce, SharedString, Styled as _, Window,
    div,
};

use super::scope;
use crate::ui::Icon;
use crate::ui::context::Ds;
use crate::ui::dropdown_menu::{DropdownMenu, DropdownMenuContent, Item, Variant};
use crate::ui::icon::{IconSize, icon};
use crate::ui::icon_button::IconButton;
use crate::ui::overlay::place::Align;

type Select = Rc<dyn Fn(&mut Window, &mut App)>;
type OpenChange = Rc<dyn Fn(bool, &mut Window, &mut App)>;

/// One action of the menu.
pub struct OverflowItem {
    icon: Option<Icon>,
    label: SharedString,
    destructive: bool,
    on_select: Option<Select>,
}

impl OverflowItem {
    pub fn new(label: impl Into<SharedString>) -> Self {
        Self {
            icon: None,
            label: label.into(),
            destructive: false,
            on_select: None,
        }
    }

    pub fn icon(mut self, icon: Icon) -> Self {
        self.icon = Some(icon);
        self
    }

    pub fn destructive(mut self) -> Self {
        self.destructive = true;
        self
    }

    pub fn on_select(mut self, handler: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_select = Some(Rc::new(handler));
        self
    }
}

#[derive(IntoElement)]
pub struct OverflowActionMenu {
    id: SharedString,
    label: SharedString,
    items: Vec<OverflowItem>,
    open: Option<bool>,
    on_open_change: Option<OpenChange>,
}

impl OverflowActionMenu {
    /// `label` names the trigger button (its tooltip is the menu's name).
    pub fn new(id: impl Into<SharedString>, label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            items: Vec::new(),
            open: None,
            on_open_change: None,
        }
    }

    pub fn item(mut self, item: OverflowItem) -> Self {
        self.items.push(item);
        self
    }

    pub fn items(mut self, items: impl IntoIterator<Item = OverflowItem>) -> Self {
        self.items.extend(items);
        self
    }

    /// Controlled open state for row-context triggers.
    pub fn open(mut self, open: bool) -> Self {
        self.open = Some(open);
        self
    }

    pub fn on_open_change(
        mut self,
        handler: impl Fn(bool, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_open_change = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for OverflowActionMenu {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let id: ElementId = self.id.clone().into();
        let mut menu = DropdownMenu::new(self.id.clone(), window, cx);
        if let Some(open) = self.open {
            menu = menu.open(open);
        }
        if let Some(handler) = self.on_open_change {
            menu = menu.on_open_change(move |open, window, cx| handler(open, window, cx));
        }
        let open = menu.is_open(cx);
        let in_scale = scope::action_scale(cx).is_some();
        let ds = Ds::get(cx);
        let trigger = menu.trigger(|toggle| {
            let button = IconButton::new((id, "trigger"), self.label.clone())
                .menu_trigger()
                .on_click(toggle.on_click());
            // A sidebar sizes the glyph of its buttons (`.shell svg`); elsewhere `size="sm"`.
            let button = if in_scale {
                button.glyph(Icon::MoreHorizontal)
            } else {
                button.icon(icon(Icon::MoreHorizontal, IconSize::Sm, ds))
            };
            if open { button.selected() } else { button }.into_any_element()
        });
        let mut content = DropdownMenuContent::new().align(Align::End).side_offset(8.);
        for item in self.items {
            let mut entry = Item::new(item.label);
            if let Some(glyph) = item.icon {
                entry = entry.icon(glyph);
            }
            if item.destructive {
                entry = entry.variant(Variant::Destructive);
            }
            if let Some(handler) = item.on_select {
                entry = entry.on_select(move |window, cx| handler(window, cx));
            }
            content = content.child(entry);
        }
        let content = menu.content(content, window, cx);
        div().flex().child(trigger).child(content)
    }
}
