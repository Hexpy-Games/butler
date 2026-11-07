//! DS CommandPanel (CommandPanel.tsx / CommandPanel.module.css): [`CommandPanel`], the search
//! field and results shell on a SurfacePanel, and [`CommandPalettePanel`], the Cmd+K palette on
//! the Dialog `palette` motion. The palette renders its results as a listbox of option rows and
//! owns the active row: it starts at the first result, ArrowDown and ArrowUp move it, Enter runs
//! it, and a pointer move over a row makes it the active one. Command execution stays with the
//! caller. Keep the palette in the tree and toggle [`CommandPalettePanel::open`], so it can
//! animate out.
mod parts;

use std::rc::Rc;

use gpui::{
    AnyElement, App, ElementId, Entity, InteractiveElement as _, IntoElement, KeyDownEvent,
    ParentElement, RenderOnce, ScrollHandle, SharedString, Styled as _, Window, div, px,
};

use super::surface_panel::{Elevation, SurfacePanel};
use crate::tokens::{Color, Length};
use crate::ui::Icon;
use crate::ui::context::{Ds, Platform};
use crate::ui::dialog::{Dialog, DialogContent, Motion, Size};
use crate::ui::icon::{IconSize, icon};
use crate::ui::layout::{Space, Stack};
use crate::ui::text::Input;

pub use parts::highlight;

type Action = Rc<dyn Fn(&mut Window, &mut App)>;
type Change = Rc<dyn Fn(&str, &mut Window, &mut App)>;

/// `.panel`: `max-width: min(100%, 620px)` (DS: CommandPanel.module.css:2).
const PANEL_MAX_WIDTH: f32 = 620.;

/// `CommandPanel`: a search field over the results the caller renders as children.
#[derive(IntoElement)]
pub struct CommandPanel {
    id: ElementId,
    query: SharedString,
    placeholder: Option<SharedString>,
    on_query_change: Change,
    children: Vec<AnyElement>,
}

impl CommandPanel {
    pub fn new(id: impl Into<ElementId>, query: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            query: query.into(),
            placeholder: None,
            on_query_change: Rc::new(|_, _, _| {}),
            children: Vec::new(),
        }
    }

    pub fn placeholder(mut self, placeholder: impl Into<SharedString>) -> Self {
        self.placeholder = Some(placeholder.into());
        self
    }

    pub fn on_query_change(
        mut self,
        handler: impl Fn(&str, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_query_change = Rc::new(handler);
        self
    }
}

impl ParentElement for CommandPanel {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for CommandPanel {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let change = self.on_query_change;
        let mut input = Input::new((self.id.clone(), "search"))
            .value(self.query)
            .on_change(move |text, window, cx| change(text, window, cx));
        if let Some(placeholder) = self.placeholder {
            input = input.placeholder(placeholder);
        }
        // `.search`: an icon column and the field, centred.
        let search = div()
            .flex()
            .items_center()
            .gap(ds.len(Length::SpaceSm))
            .child(icon(Icon::Search, IconSize::Md, ds))
            .child(div().flex_1().min_w_0().child(input));
        let panel = SurfacePanel::new().elevation(Elevation::High).child(
            Stack::new()
                .gap(Space::Sm)
                .child(search)
                .child(div().min_w_0().children(self.children)),
        );
        div()
            .w_full()
            .max_w(px(PANEL_MAX_WIDTH))
            .child(panel)
            .into_any_element()
    }
}

/// One result row of the palette: a leading icon, the title, and a muted subtitle at the end.
pub struct CommandPaletteItem {
    id: SharedString,
    title: AnyElement,
    subtitle: Option<AnyElement>,
    icon: Option<AnyElement>,
    on_select: Action,
}

impl CommandPaletteItem {
    /// `title` may carry query matches: build it with [`highlight`].
    pub fn new(
        id: impl Into<SharedString>,
        title: impl IntoElement,
        on_select: impl Fn(&mut Window, &mut App) + 'static,
    ) -> Self {
        Self {
            id: id.into(),
            title: title.into_any_element(),
            subtitle: None,
            icon: None,
            on_select: Rc::new(on_select),
        }
    }

    pub fn subtitle(mut self, subtitle: impl IntoElement) -> Self {
        self.subtitle = Some(subtitle.into_any_element());
        self
    }

    pub fn icon(mut self, icon: impl IntoElement) -> Self {
        self.icon = Some(icon.into_any_element());
        self
    }
}

/// Whether `event` is the palette's toggle: Cmd+K (Ctrl+K off macOS), not a key repeat. Bind it
/// in the host's key handling to open the palette; the palette closes itself on it.
pub fn is_toggle_key(event: &KeyDownEvent, platform: Platform) -> bool {
    let modifiers = event.keystroke.modifiers;
    let chord = if platform == Platform::Mac {
        modifiers.platform
    } else {
        modifiers.control
    };
    event.keystroke.key == "k" && chord && !modifiers.alt && !modifiers.shift && !event.is_held
}

/// `CommandPalettePanel`: the Cmd+K palette.
#[derive(IntoElement)]
pub struct CommandPalettePanel {
    id: ElementId,
    open: bool,
    query: SharedString,
    placeholder: SharedString,
    close_label: SharedString,
    items: Vec<CommandPaletteItem>,
    feedback: Option<AnyElement>,
    on_close: Action,
    on_query_change: Change,
}

impl CommandPalettePanel {
    pub fn new(
        id: impl Into<ElementId>,
        _label: impl Into<SharedString>,
        placeholder: impl Into<SharedString>,
        close_label: impl Into<SharedString>,
    ) -> Self {
        Self {
            id: id.into(),
            open: true,
            query: SharedString::default(),
            placeholder: placeholder.into(),
            close_label: close_label.into(),
            items: Vec::new(),
            feedback: None,
            on_close: Rc::new(|_, _| {}),
            on_query_change: Rc::new(|_, _, _| {}),
        }
    }

    /// Keep the panel in the tree and toggle this, so the palette can animate out.
    pub fn open(mut self, open: bool) -> Self {
        self.open = open;
        self
    }

    /// The text the field shows (controlled), with the change callback.
    pub fn query(
        mut self,
        value: impl Into<SharedString>,
        on_change: impl Fn(&str, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.query = value.into();
        self.on_query_change = Rc::new(on_change);
        self
    }

    pub fn items(mut self, items: Vec<CommandPaletteItem>) -> Self {
        self.items = items;
        self
    }

    /// Caller-owned loading, empty or failed-search feedback, above the results.
    pub fn feedback(mut self, feedback: impl IntoElement) -> Self {
        self.feedback = Some(feedback.into_any_element());
        self
    }

    pub fn on_close(mut self, handler: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_close = Rc::new(handler);
        self
    }
}

/// The active row's index: the stored one, held inside the current results.
fn clamp(active: usize, count: usize) -> Option<usize> {
    count.checked_sub(1).map(|last| active.min(last))
}

/// What the key handler and the rows share: the active row and the results' scroll.
#[derive(Clone)]
pub(crate) struct Nav {
    pub active: Entity<usize>,
    pub scroll: ScrollHandle,
    /// Children of the scroller before the first row (the feedback).
    pub lead: usize,
}

impl Nav {
    pub(crate) fn set(&self, index: usize, scroll_to: bool, cx: &mut App) {
        if *self.active.read(cx) != index {
            self.active.update(cx, |active, cx| {
                *active = index;
                cx.notify();
            });
        }
        if scroll_to {
            self.scroll.scroll_to_item(self.lead + index);
        }
    }
}

impl RenderOnce for CommandPalettePanel {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let nav = Nav {
            active: window.use_keyed_state((self.id.clone(), "active"), cx, |_, _| 0),
            scroll: window
                .use_keyed_state((self.id.clone(), "scroll"), cx, |_, _| ScrollHandle::new())
                .read(cx)
                .clone(),
            lead: usize::from(self.feedback.is_some()),
        };
        let close = self.on_close.clone();
        let dialog = Dialog::new((self.id.clone(), "dialog"), window, cx)
            .open(self.open)
            .on_open_change(move |open, window, cx| {
                if !open {
                    close(window, cx);
                }
            });
        let input_row = parts::input_row(&self, &nav, window, cx);
        let active = clamp(*nav.active.read(cx), self.items.len());
        let actions: Vec<Action> = self.items.iter().map(|i| i.on_select.clone()).collect();
        let ds = Ds::get(cx);
        let keys = parts::keys(&nav, actions, self.on_close.clone(), ds.platform());
        let results = parts::results(&self.id, self.feedback, self.items, active, &nav, ds);
        let panel = div()
            .flex()
            .flex_col()
            .overflow_hidden()
            .min_w_0()
            .text_color(ds.color(Color::TextPrimary))
            .capture_key_down(keys)
            .child(input_row)
            .child(results);
        let content = DialogContent::new()
            .motion(Motion::Palette)
            .size(Size::Md)
            .show_close_button(false)
            .child(parts::flush(panel, ds));
        dialog.content(content, window, cx)
    }
}
