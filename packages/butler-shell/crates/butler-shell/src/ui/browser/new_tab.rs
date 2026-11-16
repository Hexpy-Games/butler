//! `Bookmarks.tsx` NewTabPage, sharing the library's cards, reads and live bus.
use crate::ui::{
    Icon,
    i18n::browser::BrowserStrings,
    manage::{
        self, LibraryKind, LibraryView, ManageCtx, Topic, View,
        library::{
            CARD_COLUMNS,
            detail::attach_dialog,
            library_card, open_library_item,
            types::{LibraryItem, LibraryPageData},
        },
    },
    source::fetch::fetch,
    widgets::anchor,
};
use butler_ds::ui::{
    blocks::{
        empty_line::EmptyLine,
        overflow_action_menu::{OverflowActionMenu, OverflowItem},
    },
    button::{Button, Size, Variant},
    layout::{Box as DsBox, Grid, Space, Stack},
    page_container::{Gutter, PageContainer, PageWidth},
    section::Section,
    tag::Tag,
};
use gpui::{
    AnyElement, App, Context, IntoElement, ParentElement as _, Render, SharedString, Subscription,
    Window, div,
};
use std::rc::Rc;

#[derive(Default)]
struct LibraryList {
    items: Vec<LibraryItem>,
    next: Option<String>,
    loading: bool,
    failed: bool,
}
pub(crate) struct NewTabPage {
    bookmarks: LibraryList,
    scraps: LibraryList,
    _live: Subscription,
    ctx: ManageCtx,
    revision: u64,
    generation: u64,
    attachment: Option<LibraryItem>,
}
pub(super) fn page(key: &str, window: &mut Window, cx: &mut App) -> AnyElement {
    let Some(ctx) = manage::window_ctx(cx) else {
        return div().into_any_element();
    };
    window
        .use_keyed_state(
            (
                gpui::ElementId::Name(format!("browser:{key}").into()),
                "new-tab",
            ),
            cx,
            |_, cx| NewTabPage::new(ctx, cx),
        )
        .into_any_element()
}
impl NewTabPage {
    fn new(ctx: ManageCtx, cx: &mut Context<Self>) -> Self {
        let revision = ctx.live.read(cx).revision(&Topic::Library);
        let live = cx.observe(&ctx.live, |page: &mut Self, _, cx| {
            let revision = page.ctx.live.read(cx).revision(&Topic::Library);
            if revision != page.revision {
                page.revision = revision;
                page.generation += 1;
                page.load(false, None, cx);
                page.load(true, None, cx);
            }
        });
        let mut page = Self {
            bookmarks: LibraryList::default(),
            scraps: LibraryList::default(),
            _live: live,
            ctx,
            revision,
            generation: 0,
            attachment: None,
        };
        page.load(false, None, cx);
        page.load(true, None, cx);
        page
    }
    fn list(&mut self, scrap: bool) -> &mut LibraryList {
        if scrap {
            &mut self.scraps
        } else {
            &mut self.bookmarks
        }
    }
    fn load(&mut self, scrap: bool, cursor: Option<String>, cx: &mut Context<Self>) {
        let list = self.list(scrap);
        list.loading = true;
        list.failed = false;
        let append = cursor.is_some();
        let generation = self.generation;
        fetch(
            cx,
            move |client| async move {
                client
                    .list_library(
                        Some(if scrap { "scrap" } else { "bookmark" }),
                        None,
                        cursor.as_deref(),
                        None,
                        None,
                        None,
                        None,
                        None,
                        None,
                        None,
                        None,
                    )
                    .await
            },
            move |page, result: Result<LibraryPageData, _>, cx| {
                if page.generation != generation {
                    return;
                }
                let list = page.list(scrap);
                list.loading = false;
                match result {
                    Ok(next) => {
                        if append {
                            list.items.extend(next.items);
                        } else {
                            list.items = next.items;
                        }
                        list.next = next.next_cursor;
                    }
                    Err(_) => list.failed = true,
                }
                cx.notify();
            },
        );
    }
    fn cards(&self, items: &[LibraryItem], id: SharedString, cx: &mut Context<Self>) -> Grid {
        let mut grid = Grid::new(id)
            .columns(CARD_COLUMNS)
            .gap(Space::Md)
            .page_container();
        let words = crate::ui::manage::library::card_words(cx);
        for item in items {
            let id = SharedString::from(format!("new-tab-item-{}", item.id));
            let (ctx, opened) = (self.ctx.clone(), item.clone());
            let (page, attached) = (cx.entity(), item.clone());
            let menu =
                OverflowActionMenu::new(SharedString::from(format!("{id}-menu")), words.more).item(
                    OverflowItem::new(words.attach)
                        .icon(Icon::MessageSquarePlus)
                        .on_select(move |_, cx| {
                            page.update(cx, |page, cx| {
                                page.attachment = Some(attached.clone());
                                cx.notify();
                            });
                        }),
                );
            let card = library_card(item, id.clone(), cx)
                .menu(menu)
                .on_open(move |_, _, cx| open_library_item(&ctx, &opened, false, cx));
            grid = grid.child(anchor(div(), &id).child(card));
        }
        grid
    }
    fn bookmarks(&self, cx: &mut Context<Self>) -> Section {
        let c = BrowserStrings::get(cx);
        let mut folders: Vec<&str> = Vec::new();
        for item in &self.bookmarks.items {
            let name = item.folder.as_deref().unwrap_or_default();
            if !folders.contains(&name) {
                folders.push(name);
            }
        }
        let mut groups = Stack::new().gap(Space::Lg);
        for (i, name) in folders.into_iter().enumerate() {
            let items: Vec<_> = self
                .bookmarks
                .items
                .iter()
                .filter(|item| item.folder.as_deref().unwrap_or_default() == name)
                .cloned()
                .collect();
            let mut group = Stack::new().gap(Space::Sm);
            if !name.is_empty() {
                group = group.child(
                    Tag::new(
                        SharedString::from(format!("new-tab-folder-{i}")),
                        name.to_owned(),
                    )
                    .icon(Icon::Folder),
                );
            }
            groups = groups.child(group.child(self.cards(
                &items,
                format!("new-tab-grid-{i}").into(),
                cx,
            )));
        }
        let mut section = Section::new("new-tab-bookmarks")
            .title(c.bookmarks)
            .child(groups);
        if !self.bookmarks.loading && self.bookmarks.items.is_empty() {
            section = section.child(EmptyLine::new(if self.bookmarks.failed {
                c.failed
            } else {
                c.empty_library
            }));
        }
        if let Some(cursor) = self.bookmarks.next.clone() {
            let page = cx.entity();
            let mut more = Button::new("new-tab-more")
                .variant(Variant::Ghost)
                .text(c.load_more)
                .on_click(move |_, _, cx| {
                    page.update(cx, |page, cx| {
                        if !page.bookmarks.loading {
                            page.load(false, Some(cursor.clone()), cx);
                        }
                    });
                });
            if self.bookmarks.loading {
                more = more.disabled();
            }
            section = section.child(more);
        }
        section
    }
    fn attach(&self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let item = self.attachment.as_ref()?;
        let page = cx.entity();
        Some(attach_dialog(
            &self.ctx,
            std::slice::from_ref(item),
            Rc::new(move |_, cx| {
                page.update(cx, |page, cx| {
                    page.attachment = None;
                    cx.notify();
                });
            }),
            window,
            cx,
        ))
    }
}
impl Render for NewTabPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let c = BrowserStrings::get(cx);
        let ctx = self.ctx.clone();
        let all = Button::new("new-tab-view-all")
            .size(Size::Xs)
            .variant(Variant::Ghost)
            .text(c.view_all)
            .on_click(move |_, _, cx| {
                ctx.set_view(
                    View::Library(LibraryView {
                        section: Some(LibraryKind::Scrap),
                        ..LibraryView::default()
                    }),
                    cx,
                );
            });
        let mut scraps = Section::new("new-tab-scraps")
            .title(c.recent_scraps)
            .actions(all)
            .child(self.cards(
                &self.scraps.items[..self.scraps.items.len().min(3)],
                "new-tab-scrap-grid".into(),
                cx,
            ));
        if !self.scraps.loading && self.scraps.items.is_empty() {
            scraps = scraps.child(EmptyLine::new(if self.scraps.failed {
                c.failed
            } else {
                c.empty_library
            }));
        }
        PageContainer::new()
            .width(PageWidth::Full)
            .gutter(Gutter::Xl)
            .child(
                DsBox::new().padding_y(Space::Xl).child(
                    Stack::new()
                        .gap(Space::Xl)
                        .child(self.bookmarks(cx))
                        .child(scraps)
                        .children(self.attach(window, cx)),
                ),
            )
    }
}
