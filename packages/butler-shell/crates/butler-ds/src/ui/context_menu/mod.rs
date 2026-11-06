//! DS ContextMenu (shadcn/ui/context-menu.tsx over Radix ContextMenu): a modal menu that opens
//! at the pointer when the trigger is right-clicked, to the right of the point and aligned to its
//! start (side right, offset 2). While it is open the page is scroll-locked, pointer events
//! outside are blocked and Tab is prevented. Only [`Item`] is exported, as in React: no labels,
//! separators or submenus. The touch long-press (700ms) is not ported: there is no touch input.
use std::rc::Rc;

use gpui::{
    AnyElement, App, Bounds, InteractiveElement as _, IntoElement, MouseButton, ParentElement as _,
    Window, div, size,
};

use super::menu::{Entry, Menu, Spec};
pub use super::menu::{Item, Variant};
use super::overlay::place::{Align, Side};
use super::overlay::theme::Theme;

/// `ContextMenuContent`: its items.
pub struct ContextMenuContent {
    theme: Option<Theme>,
    entries: Vec<Entry>,
}

impl ContextMenuContent {
    pub fn new() -> Self {
        Self {
            theme: None,
            entries: Vec::new(),
        }
    }

    /// The theme of the layer; by default the trigger's.
    pub fn theme(mut self, theme: Theme) -> Self {
        self.theme = Some(theme);
        self
    }

    pub fn child(mut self, item: Item) -> Self {
        self.entries.push(item.into());
        self
    }
}

impl Default for ContextMenuContent {
    fn default() -> Self {
        Self::new()
    }
}

/// A context menu's runtime: state owned by the keyed states of its id.
#[derive(Clone)]
pub struct ContextMenu {
    menu: Menu,
}

impl ContextMenu {
    pub fn new(id: impl Into<gpui::SharedString>, window: &mut Window, cx: &mut App) -> Self {
        Self {
            menu: Menu::new(id, window, cx),
        }
    }

    pub fn on_open_change(
        mut self,
        handler: impl Fn(bool, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.menu = self.menu.on_open_change(Some(Rc::new(handler)));
        self
    }

    pub fn is_open(&self, cx: &App) -> bool {
        self.menu.is_open(cx)
    }

    /// The trigger: a right button press anywhere on `child` opens the menu at the pointer, a
    /// zero-size anchor.
    pub fn trigger(&self, child: impl IntoElement) -> AnyElement {
        let menu = self.menu.clone();
        div()
            .on_mouse_down(MouseButton::Right, move |event, window, cx| {
                let at = Bounds::new(event.position, size(gpui::px(0.), gpui::px(0.)));
                menu.parts.reference.cell().set(Some(at));
                menu.open_with(false, window, cx);
            })
            .child(child)
            .into_any_element()
    }

    /// The surface, in the top layer while open and during its exit.
    pub fn content(
        &self,
        content: ContextMenuContent,
        window: &mut Window,
        cx: &mut App,
    ) -> AnyElement {
        let spec = Spec {
            side: Side::Right,
            align: Align::Start,
            side_offset: 2., // Radix ContextMenuContent `sideOffset`
            modal: true,
            cap_height: false,
            theme: content.theme,
            trigger_focus: None,
            sheet: false,
        };
        self.menu.content(&spec, content.entries, window, cx)
    }
}
