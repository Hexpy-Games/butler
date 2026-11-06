//! DS DropdownMenu (shadcn/ui/dropdown-menu.tsx over Radix DropdownMenu, `modal = false`): a
//! non-modal menu anchored to its trigger. A left-button press on the trigger toggles it (a
//! keyboard activation does too, and ArrowDown opens); a keyboard open highlights the first
//! item, a pointer open leaves focus on the content. Items come from [`Item`] and the other
//! menu entries: roving highlight with typeahead, close on select, Tab prevented, submenus with
//! a 100ms open intent and a 300ms grace polygon. A press on an item, a drag and a release over
//! another selects the one under the release.
use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, FocusHandle, InteractiveElement as _, IntoElement as _,
    MouseButton, ParentElement as _, Styled as _, Window, div,
};

pub use super::menu::{
    CheckboxItem, Checked, Entry, Group, Item, RadioGroup, RadioItem, Sub, Variant,
};
use super::menu::{Menu, Spec, TriggerBox};
use super::overlay::Presentation;
use super::overlay::place::{Align, Side};
use super::overlay::theme::Theme;

/// The props of `DropdownMenuContent`.
pub struct DropdownMenuContent {
    side: Side,
    align: Align,
    side_offset: f32,
    theme: Option<Theme>,
    presentation: Option<Presentation>,
    entries: Vec<Entry>,
}

impl DropdownMenuContent {
    pub fn new() -> Self {
        Self {
            side: Side::Bottom,
            align: Align::Start,
            side_offset: 4., // DS: dropdown-menu.tsx:51
            theme: None,
            presentation: None,
            entries: Vec::new(),
        }
    }

    /// Radix default: bottom.
    pub fn side(mut self, side: Side) -> Self {
        self.side = side;
        self
    }

    /// Default `start`.
    pub fn align(mut self, align: Align) -> Self {
        self.align = align;
        self
    }

    pub fn side_offset(mut self, offset: f32) -> Self {
        self.side_offset = offset;
        self
    }

    /// The theme of the layer; by default the trigger's.
    pub fn theme(mut self, theme: Theme) -> Self {
        self.theme = Some(theme);
        self
    }

    /// `auto | popover | sheet`: a BottomSheet below 768px, anchored above (the app default).
    pub fn presentation(mut self, presentation: Presentation) -> Self {
        self.presentation = Some(presentation);
        self
    }

    pub fn child(mut self, entry: impl Into<Entry>) -> Self {
        self.entries.push(entry.into());
        self
    }

    /// A `DropdownMenuLabel`.
    pub fn label(self, text: impl Into<gpui::SharedString>) -> Self {
        self.child(Entry::label(text))
    }

    /// A `DropdownMenuSeparator`.
    pub fn separator(self) -> Self {
        self.child(Entry::separator())
    }
}

impl Default for DropdownMenuContent {
    fn default() -> Self {
        Self::new()
    }
}

/// A dropdown menu's runtime: state owned by the keyed states of its id.
#[derive(Clone)]
pub struct DropdownMenu {
    menu: Menu,
    trigger_focus: FocusHandle,
}

/// Hand its [`Toggle::on_click`] to the trigger control: a keyboard or touch activation toggles
/// the menu (a mouse press already did, on the way down).
#[derive(Clone)]
pub struct Toggle(DropdownMenu);

impl Toggle {
    pub fn on_click(&self) -> impl Fn(&ClickEvent, &mut Window, &mut App) + 'static {
        let menu = self.0.clone();
        move |event, window, cx| {
            if !matches!(event, ClickEvent::Mouse(_)) {
                menu.toggle(event.is_keyboard(), window, cx);
            }
        }
    }
}

impl DropdownMenu {
    pub fn new(id: impl Into<gpui::SharedString>, window: &mut Window, cx: &mut App) -> Self {
        let id: gpui::SharedString = id.into();
        let key: gpui::ElementId = id.clone().into();
        let trigger_focus = window
            .use_keyed_state((key, "trigger-focus"), cx, |_, cx| cx.focus_handle())
            .read(cx)
            .clone();
        Self {
            menu: Menu::new(id, window, cx),
            trigger_focus,
        }
    }

    /// Controlled: the caller owns the open state and hears changes in `on_open_change`.
    pub fn open(mut self, open: bool) -> Self {
        self.menu = self.menu.controlled(open);
        self
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

    fn toggle(&self, keyboard: bool, window: &mut Window, cx: &mut App) {
        if self.menu.is_open(cx) {
            self.menu.close(window, cx);
        } else {
            self.menu.open_with(keyboard, window, cx);
        }
    }

    /// The trigger: `build` makes the control from a [`Toggle`]. The box is as wide as the
    /// control.
    pub fn trigger(&self, build: impl FnOnce(Toggle) -> AnyElement) -> AnyElement {
        let (press, keys, focus) = (self.clone(), self.clone(), self.trigger_focus.clone());
        // A flex box: the control is its item, with no line box (and strut) around it.
        let child = div()
            .flex()
            .child(build(Toggle(self.clone())))
            .child(self.menu.parts.reference.probe())
            .relative();
        TriggerBox::new(child.into_any_element(), move |wrapper| {
            wrapper
                .track_focus(&focus)
                .tab_stop(false)
                .capture_any_mouse_down(move |event, window, cx| {
                    if event.button == MouseButton::Left && !event.modifiers.control {
                        press.toggle(false, window, cx);
                    }
                })
                .on_key_down(move |event, window, cx| {
                    if event.keystroke.key == "down" && !keys.menu.is_open(cx) {
                        cx.stop_propagation();
                        keys.menu.open_with(true, window, cx);
                    }
                })
        })
        .into_any_element()
    }

    /// The surface, in the top layer while open and during its exit.
    pub fn content(
        &self,
        content: DropdownMenuContent,
        window: &mut Window,
        cx: &mut App,
    ) -> AnyElement {
        let viewport = window.viewport_size();
        let sheet = content
            .presentation
            .unwrap_or_default()
            .is_sheet(f32::from(viewport.width));
        let spec = Spec {
            side: content.side,
            align: content.align,
            side_offset: content.side_offset,
            modal: false,
            cap_height: true,
            theme: content.theme,
            trigger_focus: Some(self.trigger_focus.clone()),
            sheet,
        };
        self.menu.content(&spec, content.entries, window, cx)
    }
}
