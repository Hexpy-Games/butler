//! The 서랍 (`browser/LibraryPage.tsx`, `library/LibraryMain.tsx`): the main screen, a kind's
//! view and a group, beside the detail panel. The page keeps the filters, the selection and the
//! reads of every level; the viewer, the dialogs (one host, the shell's) and the detail are M4's.
#![allow(
    dead_code,
    reason = "seam: M4 and the dialogs read some of the 서랍's types"
)]
pub(crate) mod detail;
mod filters;
mod kind;
mod main;
mod toolbar;
pub(crate) mod types;

use std::collections::HashMap;
use std::rc::Rc;

use butler_ds::ui::layout::{Box as DsBox, Space, Stack};
use butler_ds::ui::page_container::{Gutter, PageContainer, PageWidth};
use butler_ds::ui::scroll::ScrollArea;
use gpui::{
    AnyElement, AnyView, App, AppContext as _, Context, Entity, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, SharedString, Styled as _, Subscription, Task, Window,
    div,
};

use self::detail::{LibraryDetail, LibraryDialogsEvent, attach_dialog, dialog_host, file_viewer};
use self::filters::Filters;
use self::filters::query::Query;
use self::kind::Selection;
use self::main::data::{Cell, List, TagList};
use self::main::tiles::Drag;
use self::types::{LibraryFacets, LibraryGroups, LibraryItem, LibraryPageData};
use super::documents::reading_page;
use super::{Action, LibraryKind, LibraryView, ManageCtx, Pick, Topic, View};
use crate::ui::widgets::anchor;

/// The file viewer key the 서랍 opens files under (`LibraryFileViewer`).
pub(crate) const LIBRARY_VIEWER: &str = "library";

/// `LibraryPage`
pub(crate) fn page(ctx: ManageCtx, window: &mut Window, cx: &mut App) -> AnyView {
    cx.new(|cx| LibraryPage::new(ctx, window, cx)).into()
}

/// `openLibrary`: the 서랍 at a level (the main screen, a kind, a group in it).
pub(crate) fn open_library(
    ctx: &ManageCtx,
    section: Option<LibraryKind>,
    group: Option<SharedString>,
    cx: &mut App,
) {
    ctx.set_view(
        View::Library(LibraryView {
            section,
            group,
            ..LibraryView::default()
        }),
        cx,
    );
}

struct LibraryPage {
    ctx: ManageCtx,
    /// The level last read for, and the live revision last acted on.
    seen: LibraryView,
    revision: u64,
    /// One round of reads; a Library change starts the next.
    generation: u64,
    filters: Filters,
    /// The pause after typing, before the query settles on the text.
    search: Option<Task<()>>,
    selection: Selection,
    tags: Cell<TagList>,
    rows: HashMap<Query, Cell<LibraryPageData>>,
    facets: HashMap<String, Cell<LibraryFacets>>,
    groups: HashMap<LibraryKind, Cell<LibraryGroups>>,
    list: List,
    /// The card being renamed in place.
    editing: Option<String>,
    /// The item the attach dialog is open for.
    attachment: Option<LibraryItem>,
    /// The cards lifted and the group they are over.
    drag: Drag,
    /// `ManageTagsDialog`'s `setFilters`, heard from the shell's dialog host.
    _tags: Option<Subscription>,
    detail: Option<(LibraryView, Entity<LibraryDetail>)>,
    document: Option<(SharedString, AnyView)>,
}

impl LibraryPage {
    fn new(ctx: ManageCtx, _window: &mut Window, cx: &mut Context<Self>) -> Self {
        cx.observe(&ctx.state, |this, _, cx| this.view_moved(cx))
            .detach();
        cx.observe(&ctx.live, |this, _, cx| this.live_moved(cx))
            .detach();
        let tags = dialog_host(cx).map(|host| {
            cx.subscribe(&host, |this, _, event: &LibraryDialogsEvent, cx| {
                let LibraryDialogsEvent::TagChanged { from, to } = event;
                this.tag_changed(from, to.as_ref(), cx);
            })
        });
        let revision = ctx.live.read(cx).revision(&Topic::Library);
        let seen = match ctx.view(cx) {
            View::Library(view) => view,
            _ => LibraryView::default(),
        };
        let mut page = Self {
            ctx,
            seen,
            revision,
            generation: 0,
            filters: Filters::default(),
            search: None,
            selection: Selection::default(),
            tags: Cell::default(),
            rows: HashMap::new(),
            facets: HashMap::new(),
            groups: HashMap::new(),
            list: List::default(),
            editing: None,
            attachment: None,
            drag: Drag::default(),
            _tags: tags,
            detail: None,
            document: None,
        };
        page.refresh(false, cx);
        page
    }

    /// The shell changed the view: another level reads what it shows.
    fn view_moved(&mut self, cx: &mut Context<Self>) {
        let View::Library(view) = self.ctx.view(cx) else {
            return;
        };
        if view != self.seen {
            self.seen = view;
            self.refresh(false, cx);
        }
    }

    /// `ManageTagsDialog`: a filter on a renamed tag follows it, on a deleted tag goes.
    fn tag_changed(&mut self, from: &str, to: Option<&SharedString>, cx: &mut Context<Self>) {
        if !self.filters.tags.iter().any(|tag| tag == from) {
            return;
        }
        self.set_filters(
            |filters| {
                let mut tags: Vec<String> = Vec::new();
                for tag in &filters.tags {
                    let next = if tag == from {
                        to.map(ToString::to_string)
                    } else {
                        Some(tag.clone())
                    };
                    if let Some(next) = next
                        && !tags.contains(&next)
                    {
                        tags.push(next);
                    }
                }
                filters.tags = tags;
            },
            cx,
        );
    }

    /// `useLibraryVersion`: a Library change reads every list again.
    fn live_moved(&mut self, cx: &mut Context<Self>) {
        let revision = self.ctx.live.read(cx).revision(&Topic::Library);
        if revision != self.revision {
            self.revision = revision;
            self.refresh(true, cx);
        }
    }

    /// `onAttach`: the attach dialog opens for the item.
    fn attach_pick(page: &Entity<Self>) -> Pick<LibraryItem> {
        let page = page.clone();
        Rc::new(move |item: LibraryItem, _: &mut Window, cx: &mut App| {
            page.update(cx, |page, cx| {
                page.attachment = Some(item);
                cx.notify();
            });
        })
    }

    /// `LibraryAttachDialog`: open while an item waits to be attached.
    fn attach(&self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let item = self.attachment.clone()?;
        let page = cx.entity();
        let close: Action = Rc::new(move |_: &mut Window, cx: &mut App| {
            page.update(cx, |page, cx| {
                page.attachment = None;
                cx.notify();
            });
        });
        Some(attach_dialog(
            &self.ctx,
            std::slice::from_ref(&item),
            close,
            window,
            cx,
        ))
    }

    /// `LibraryContent`
    fn content(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let view = self.view(cx);
        if view.doc.is_none() {
            self.document = None;
        }
        if view.item.is_none() {
            self.detail = None;
        }
        if let Some(id) = view.doc.clone() {
            return self.reading(id, window, cx);
        }
        if view.item.is_some() {
            return self.detail_panel(&view, window, cx);
        }
        let body = match view.section {
            Some(kind) => self.kind_view(&view, kind, cx),
            None => self.main_screen(&view, window, cx),
        };
        let column = Stack::new()
            .gap(Space::Xl)
            .child(self.toolbar(&view, window, cx))
            .child(body)
            .children(self.attach(window, cx));
        ScrollArea::new("library-scroll")
            .fill()
            .child(
                PageContainer::new()
                    .width(PageWidth::Full)
                    .gutter(Gutter::Xl)
                    .child(DsBox::new().padding_y(Space::Xl).child(column)),
            )
            .into_any_element()
    }

    /// `DocumentReadingPage`, remounted per document (`key={view.doc}`).
    fn reading(
        &mut self,
        id: SharedString,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        if self.document.as_ref().map(|(shown, _)| shown) != Some(&id) {
            let page = reading_page(self.ctx.clone(), id.clone(), window, cx);
            self.document = Some((id, page));
        }
        self.document.as_ref().map_or_else(
            || div().into_any_element(),
            |(_, page)| page.clone().into_any_element(),
        )
    }

    /// `LibraryDetail` and the attach dialog beside it.
    fn detail_panel(
        &mut self,
        view: &LibraryView,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        if self.detail.as_ref().map(|(shown, _)| shown) != Some(view) {
            let (ctx, level) = (self.ctx.clone(), view.clone());
            let on_attach = Self::attach_pick(&cx.entity());
            let panel = cx.new(|cx| LibraryDetail::new(ctx, level, on_attach, window, cx));
            self.detail = Some((view.clone(), panel));
        }
        let panel = self.detail.as_ref().map(|(_, panel)| panel.clone());
        div()
            .size_full()
            .children(panel)
            .children(self.attach(window, cx))
            .into_any_element()
    }
}

impl Render for LibraryPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let viewer = file_viewer(&self.ctx, window, cx);
        let body = match viewer {
            Some(viewer) => viewer,
            None => self.content(window, cx),
        };
        // A column, so a body whose root is a `ScrollArea::fill` fills the page.
        anchor(
            div().id("library-region").size_full().flex().flex_col(),
            "library-page",
        )
        .child(body)
    }
}
