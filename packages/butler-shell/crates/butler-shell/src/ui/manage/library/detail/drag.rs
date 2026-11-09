//! `library/libraryCardDrag.ts`, `libraryGroupDrag.ts`, `CardDragPreview.tsx`, `libraryDrop.ts`:
//! cards lift out of the 서랍 and drop on a group tile or chip of their kind, or on a
//! conversation; group tiles and chips reorder among their kind; a drag resting on the sidebar's
//! 서랍 row opens its main screen so a card can land on a tile.
//!
//! React drives these by hand from window pointer events; here the element that shows a card
//! (or tile) starts a gpui drag with [`CardDrag`] (or [`GroupDrag`]) and the target takes the
//! drop through the functions below. `libraryDragClick.ts` (the click a pointer drop
//! synthesises) has no counterpart: a gpui drop sends no click.
// ANIM-MIGRATE(CardDragPreview): React fades the lifted stack out when it is invalid; gpui hands
// the ghost no target, so the ghost always shows as valid.
use butler_ds::ui::blocks::drag_preview::{DragPreview, DragPreviewImage};
use butler_ds::ui::context::Ds;
use butler_ds::ui::toast::{self, Toast};
use gpui::{
    App, AppContext as _, Context, Empty, Entity, ImageSource, IntoElement, ObjectFit, Render,
    SharedString, Styled as _, StyledImage as _, Window, img, px,
};
use std::rc::Rc;

use super::actions::{file_items, kind_of, pixels};
use super::api::move_group;
use super::attach::reference;
use super::copy::words;
use super::dialogs::LibraryDialog;
use super::runtime::{ctx, open_dialog, remember_view, take_view};
use crate::ui::manage::library::main::media::library_image;
use crate::ui::manage::library::types::{LibraryItem, LibraryNames};
use crate::ui::manage::{LibraryKind, LibraryView, ManageCtx, View};

/// A crop's size when the item records none.
const NATURAL: (f32, f32) = (120., 90.);

/// The payload of a card drag: the cards lifted (the selected ones, or the one).
#[derive(Clone)]
pub(crate) struct CardDrag {
    pub(crate) items: Vec<LibraryItem>,
}

/// The payload of a group tile or chip drag.
#[derive(Clone)]
pub(crate) struct GroupDrag {
    pub(crate) id: SharedString,
    pub(crate) kind: LibraryKind,
}

impl CardDrag {
    /// `groupAt`: a group of `kind` takes the cards when they are all of that kind.
    pub(crate) fn fits(&self, kind: LibraryKind) -> bool {
        let first = self
            .items
            .first()
            .map_or(LibraryKind::Scrap, |item| kind_of(item.kind));
        first == kind
    }
}

/// What follows the pointer while cards are dragged: their crops stacked, with a count.
pub(crate) struct CardGhost {
    pictures: Vec<(ImageSource, (f32, f32))>,
    count: u32,
}

/// The ghost for `drag`; the `on_drag` callback of the card returns it.
pub(crate) fn card_ghost(drag: &CardDrag, cx: &mut App) -> Entity<CardGhost> {
    let pictures = drag
        .items
        .iter()
        .filter_map(|item| {
            let natural = item
                .rect
                .map_or(NATURAL, |rect| pixels(rect.width, rect.height));
            Some((library_image(item, cx)?, natural))
        })
        .collect();
    let count = u32::try_from(drag.items.len()).unwrap_or(u32::MAX);
    cx.new(|_| CardGhost { pictures, count })
}

impl Render for CardGhost {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let images = self.pictures.iter().cloned().map(|(src, (width, height))| {
            DragPreviewImage::new(width, height, move |scale| {
                img(src)
                    .w(px(width * scale))
                    .h(px(height * scale))
                    .object_fit(ObjectFit::Cover)
                    .into_any_element()
            })
        });
        DragPreview::elements("library-card-drag", images.collect()).count(self.count)
    }
}

/// What follows the pointer while a tile or chip is dragged: nothing (React draws none).
pub(crate) struct GroupGhost;

/// The ghost for a [`GroupDrag`]; the `on_drag` callback of the tile returns it.
pub(crate) fn group_ghost(cx: &mut App) -> Entity<GroupGhost> {
    cx.new(|_| GroupGhost)
}

impl Render for GroupGhost {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        Empty
    }
}

/// A group tile or chip took the dragged cards (`dropOn`, group target).
pub(crate) fn drop_cards_on_group(drag: &CardDrag, group: &str, cx: &mut App) {
    let group = SharedString::from(group.to_owned());
    file_items(drag.items.clone(), Some(&group), cx);
    end_dwell(cx);
}

/// A conversation took the dragged cards (`dropOn`, conversation target).
pub(crate) fn drop_cards_on_session(
    ctx: &ManageCtx,
    drag: &CardDrag,
    session: &SharedString,
    cx: &mut App,
) {
    let copy = words(Ds::get(cx).lang());
    for item in &drag.items {
        ctx.attach_library(session.clone(), Rc::new(reference(item, copy)), cx);
    }
    end_dwell(cx);
}

/// A tile or chip dropped on another of its kind: it takes the other's place (`moveGroup`).
pub(crate) fn drop_group_on(drag: &GroupDrag, target: &str, cx: &mut App) {
    let names = cx.default_global::<LibraryNames>();
    let position = names
        .groups
        .get(target)
        .filter(|other| other.kind == drag.kind && *drag.id != *target)
        .map(|other| other.position);
    if let Some(position) = position {
        move_group(cx, drag.id.to_string(), position, |result, cx| {
            if result.is_err() {
                toast::show(cx, Toast::error(words(Ds::get(cx).lang()).failed));
            }
        });
    }
}

/// `afterScrap`: scraps saved without a group: offer the group list.
#[expect(
    dead_code,
    reason = "the in-app browser's element saves call it (G-cef)"
)]
pub(crate) fn after_scrap(ids: Vec<String>, cx: &mut App) {
    if !ids.is_empty() {
        open_dialog(LibraryDialog::Saved { ids, beside: false }, cx);
    }
}

/// `beginDwell`: a pick rested on 서랍; open the main screen so it can land on a group tile.
#[expect(
    dead_code,
    reason = "the in-app browser's element drags call it (G-cef)"
)]
pub(crate) fn drop_dwell(_window: &mut Window, cx: &mut App) {
    let Some(ctx) = ctx(cx) else {
        return;
    };
    let view = ctx.view(cx);
    if matches!(&view, View::Library(library) if library.section.is_none() && library.item.is_none())
    {
        return;
    }
    remember_view(view, cx);
    ctx.set_view(View::Library(LibraryView::default()), cx);
}

/// `endDwell`: the drag ended (dropped or cancelled): back to where it started.
pub(crate) fn end_dwell(cx: &mut App) {
    if let (Some(ctx), Some(view)) = (ctx(cx), take_view(cx)) {
        ctx.set_view(view, cx);
    }
}
