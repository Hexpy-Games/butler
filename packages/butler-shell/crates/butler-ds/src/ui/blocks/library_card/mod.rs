//! DS LibraryCard (LibraryCard.tsx / LibraryCard.module.css): one library item (서랍: scraps,
//! picks, saved views) on a Card with a media slot: a 16:10 preview, a kind tag, the title with
//! its source, its tags and a ⋯ menu. Lay several out in a Grid (2, 3 or 4 columns).
//!
//! The media and the title are the open target; the menu and the selection circle stay their own
//! buttons. In `selection_mode` a click toggles the selection instead of opening. Differences
//! from React, all the toolkit's: the ring of keyboard focus is the card's own (the whole card is
//! the one open target), and gpui draws no accessible names (`select_label` only enables the
//! circle, `LibraryCardEditing::label` is carried for the owner).
mod media;
mod parts;
mod preview;
mod title_input;

use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, ElementId, InteractiveElement as _, IntoElement, MouseButton,
    MouseDownEvent, ParentElement as _, RenderOnce, SharedString, Styled as _, Window, div,
};

pub use self::media::LibraryCardMedia;
pub(super) use self::media::frame;
pub(super) use self::parts::{menu_slot, meta};
pub use self::title_input::LibraryCardEditing;
use crate::tokens::Length;
use crate::ui::card::{Card, CardPadding};
use crate::ui::context::Ds;

type Open = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;
type Select = Rc<dyn Fn(bool, &ClickEvent, &mut Window, &mut App)>;
type DragDown = Rc<dyn Fn(&MouseDownEvent, &mut Window, &mut App)>;

/// A card lifted out for a drag is dimmed in place.
const DRAGGING_OPACITY: f32 = 0.45; // DS: LibraryCard.module.css:134

#[derive(IntoElement)]
pub struct LibraryCard {
    id: ElementId,
    media: LibraryCardMedia,
    title: SharedString,
    meta: Option<SharedString>,
    tag: Option<SharedString>,
    tags: Vec<SharedString>,
    max_tags: usize,
    menu: Option<AnyElement>,
    selected: bool,
    on_selected_change: Option<Select>,
    select_label: Option<SharedString>,
    selection_mode: bool,
    editing: Option<LibraryCardEditing>,
    dragging: bool,
    on_drag_pointer_down: Option<DragDown>,
    on_open: Option<Open>,
}

impl LibraryCard {
    pub fn new(
        id: impl Into<ElementId>,
        media: LibraryCardMedia,
        title: impl Into<SharedString>,
    ) -> Self {
        Self {
            id: id.into(),
            media,
            title: title.into(),
            meta: None,
            tag: None,
            tags: Vec::new(),
            max_tags: 2,
            menu: None,
            selected: false,
            on_selected_change: None,
            select_label: None,
            selection_mode: false,
            editing: None,
            dragging: false,
            on_drag_pointer_down: None,
            on_open: None,
        }
    }

    /// Source and date ("shop.example.com · Today").
    pub fn meta(mut self, meta: impl Into<SharedString>) -> Self {
        self.meta = Some(meta.into());
        self
    }

    /// The kind, a word ("Element", "View"), on the media's corner.
    pub fn tag(mut self, tag: impl Into<SharedString>) -> Self {
        self.tag = Some(tag.into());
        self
    }

    /// The item's tags, one line under the meta: the first `max_tags`, then "+N". None: no line.
    pub fn tags(mut self, tags: impl IntoIterator<Item = impl Into<SharedString>>) -> Self {
        self.tags = tags.into_iter().map(Into::into).collect();
        self
    }

    pub fn max_tags(mut self, max_tags: usize) -> Self {
        self.max_tags = max_tags;
        self
    }

    /// An OverflowActionMenu (attach, open source, delete).
    pub fn menu(mut self, menu: impl IntoElement) -> Self {
        self.menu = Some(menu.into_any_element());
        self
    }

    pub fn selected(mut self, selected: bool) -> Self {
        self.selected = selected;
        self
    }

    /// With `select_label`, a selection circle on the media's corner (on hover, always in
    /// `selection_mode`). The click event is passed so the owner can read ⌘ and Shift for ranges.
    pub fn on_selected_change(
        mut self,
        handler: impl Fn(bool, &ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_selected_change = Some(Rc::new(handler));
        self
    }

    /// Accessible name of the selection circle ("Select").
    pub fn select_label(mut self, label: impl Into<SharedString>) -> Self {
        self.select_label = Some(label.into());
        self
    }

    /// A click on the card toggles the selection instead of opening.
    pub fn selection_mode(mut self, on: bool) -> Self {
        self.selection_mode = on;
        self
    }

    /// Renders the title as a name field (rename in place).
    pub fn editing(mut self, editing: LibraryCardEditing) -> Self {
        self.editing = Some(editing);
        self
    }

    /// Lifted out for a drag: dimmed in place.
    pub fn dragging(mut self, dragging: bool) -> Self {
        self.dragging = dragging;
        self
    }

    /// Starts the App's own drag (cards onto a group tile, a chip or a conversation).
    pub fn on_drag_pointer_down(
        mut self,
        handler: impl Fn(&MouseDownEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_drag_pointer_down = Some(Rc::new(handler));
        self
    }

    /// Opens the item; the media and title are the target (the menu stays its own button).
    pub fn on_open(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_open = Some(Rc::new(handler));
        self
    }

    /// The click of the card: it opens, or in selection mode toggles. None while it is not an
    /// open target (no `on_open`, or its title is being renamed).
    fn click(&self) -> Option<Open> {
        let open = self.on_open.clone().filter(|_| self.editing.is_none())?;
        let (select, selected, mode) = (
            self.on_selected_change.clone(),
            self.selected,
            self.selection_mode,
        );
        let click: Open = Rc::new(move |event, window, cx| match &select {
            Some(select) if mode => select(!selected, event, window, cx),
            _ => open(event, window, cx),
        });
        Some(click)
    }
}

impl RenderOnce for LibraryCard {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let click = self.click();
        let Self {
            id,
            media,
            title,
            meta,
            tag,
            tags,
            max_tags,
            menu,
            selected,
            on_selected_change,
            select_label,
            selection_mode,
            editing,
            dragging,
            on_drag_pointer_down,
            on_open: _,
        } = self;
        let group: SharedString = format!("{id}-library-card").into();
        let media = media::build(&id, media, tag.as_ref(), window, cx);
        let title = match editing {
            Some(editing) => title_input::build(&id, &editing, window, cx),
            None => parts::title(title, Ds::get(cx)),
        };
        let check = match (on_selected_change, select_label) {
            (Some(select), Some(_)) => Some(parts::check(
                &id,
                selected,
                selection_mode,
                &group,
                select,
                window,
                cx,
            )),
            _ => None,
        };
        let ds = Ds::get(cx);
        let body = div()
            .flex()
            .flex_col()
            .min_w_0()
            .gap(ds.len(Length::SpaceXs))
            .child(media)
            .child(title)
            .children(meta.map(|meta| parts::meta(meta, ds)))
            .children(parts::tag_row(&id, &tags, max_tags, ds));
        let mut layout = div().group(group).relative().min_w_0().child(body);
        if dragging {
            layout = layout.opacity(DRAGGING_OPACITY);
        }
        let layout = layout
            .children(check)
            .children(menu.map(|menu| menu_slot(&id, menu)));
        let mut card = Card::new(id).padding(CardPadding::Sm).selected(selected);
        if let Some(click) = click {
            card = card
                .interactive()
                .on_click(move |event, window, cx| click(event, window, cx));
        }
        let card = card.child(layout);
        match on_drag_pointer_down {
            Some(down) => div()
                .w_full()
                .on_mouse_down(MouseButton::Left, move |event, window, cx| {
                    down(event, window, cx);
                })
                .child(card)
                .into_any_element(),
            None => card.into_any_element(),
        }
    }
}
