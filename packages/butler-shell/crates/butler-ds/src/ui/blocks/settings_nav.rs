//! DS SettingsNav (SettingsNav.tsx / SettingsNav.module.css): a titled group of settings
//! sections as navigation rows, built from an items array so every group keeps the same icon
//! size and active style. One group per `SettingsNav`; one item is active across all groups.
use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, ElementId, IntoElement, ParentElement as _, RenderOnce,
    SharedString, Styled as _, Window, div,
};

use super::nav_row::NavRow;
use super::nav_section::NavSection;
use crate::ui::Icon;

type Handler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

enum Mark {
    Glyph(Icon),
    Element(AnyElement),
}

/// One row (`SettingsNavItem`).
pub struct SettingsNavItem {
    id: SharedString,
    label: SharedString,
    mark: Option<Mark>,
    active: bool,
    badge: Option<SharedString>,
    on_select: Option<Handler>,
}

impl SettingsNavItem {
    pub fn new(id: impl Into<SharedString>, label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            mark: None,
            active: false,
            badge: None,
            on_select: None,
        }
    }

    /// A DS glyph at the row's icon size.
    pub fn glyph(mut self, glyph: Icon) -> Self {
        self.mark = Some(Mark::Glyph(glyph));
        self
    }

    pub fn icon(mut self, icon: impl IntoElement) -> Self {
        self.mark = Some(Mark::Element(icon.into_any_element()));
        self
    }

    pub fn active(mut self, active: bool) -> Self {
        self.active = active;
        self
    }

    /// Text (a number), never colour alone.
    pub fn badge(mut self, badge: impl Into<SharedString>) -> Self {
        self.badge = Some(badge.into());
        self
    }

    pub fn on_select(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_select = Some(Rc::new(handler));
        self
    }
}

#[derive(IntoElement)]
pub struct SettingsNav {
    id: ElementId,
    title: SharedString,
    items: Vec<SettingsNavItem>,
}

impl SettingsNav {
    /// `title` defaults to "Settings" (`title = "Settings"`).
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            title: "Settings".into(),
            items: Vec::new(),
        }
    }

    pub fn title(mut self, title: impl Into<SharedString>) -> Self {
        self.title = title.into();
        self
    }

    pub fn item(mut self, item: SettingsNavItem) -> Self {
        self.items.push(item);
        self
    }

    pub fn items(mut self, items: impl IntoIterator<Item = SettingsNavItem>) -> Self {
        self.items.extend(items);
        self
    }
}

impl RenderOnce for SettingsNav {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        let mut section = NavSection::new(self.id, self.title);
        for item in self.items {
            let mut row = NavRow::new(item.id, item.label);
            match item.mark {
                Some(Mark::Glyph(glyph)) => row = row.glyph(glyph),
                Some(Mark::Element(icon)) => row = row.icon(icon),
                None => {}
            }
            if let Some(badge) = item.badge {
                row = row.badge(badge);
            }
            if item.active {
                row = row.active();
            }
            if let Some(handler) = item.on_select {
                row = row.on_click(move |event, window, cx| handler(event, window, cx));
            }
            section = section.child(row);
        }
        // `.nav { width: 100%; min-width: 0 }`
        div().w_full().min_w_0().child(section)
    }
}
