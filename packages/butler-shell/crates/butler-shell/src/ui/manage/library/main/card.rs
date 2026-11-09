//! `library/LibraryItemCard.tsx`: one saved item. Open (a scrap opens its detail panel), rename
//! in place, file, tag, attach, open the source, delete.
//! A card lifts out with a gpui drag ([`CardDrag`]) and drops on a tile, a chip or a conversation.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::library_card::{LibraryCard, LibraryCardEditing, LibraryCardMedia};
use butler_ds::ui::blocks::overflow_action_menu::{OverflowActionMenu, OverflowItem};
use butler_ds::ui::toast::{self, Toast};
use butler_shell_client::Error;
use gpui::{
    AnyElement, App, ClickEvent, Context, Entity, InteractiveElement as _, IntoElement as _,
    ParentElement as _, SharedString, StatefulInteractiveElement as _, Styled as _, Window, div,
};
use serde_json::Value;

use super::copy::{Words, get};
use super::data::has_groups;
use super::media::library_image;
use super::open::{goes_to_chat, has_web_source, is_document, open_library_item};
use crate::ui::manage::library::LibraryPage;
use crate::ui::manage::library::detail::{
    CardDrag, LibraryDialog, card_ghost, item_meta, open_detail, open_dialog, rename_item,
};
use crate::ui::manage::library::types::{LibraryItem, LibraryItemKind};
use crate::ui::manage::{LibraryKind, LibraryView, Topic};
use crate::ui::source::fetch::fetch;
use crate::ui::widgets::anchor;

/// `CardSelection`: how a card takes part in the kind view's selection.
#[derive(Clone, Copy)]
pub(crate) struct CardSelection {
    /// Some card is selected: a click on any card toggles it.
    pub(crate) mode: bool,
    pub(crate) selected: bool,
}

/// The kind a card shows as its media corner tag.
fn kind_tag(item: &LibraryItem, words: &Words) -> &'static str {
    if item.block.is_some() {
        return words.block;
    }
    match item.kind {
        LibraryItemKind::Scrap => words.element,
        LibraryItemKind::Document | LibraryItemKind::Doc => words.document,
        LibraryItemKind::Bookmark => words.bookmark,
        LibraryItemKind::Output => words.output,
    }
}

/// The kind a dialog moves an item under, when it has groups.
fn group_kind(item: &LibraryItem) -> Option<LibraryKind> {
    let kind = match item.kind {
        LibraryItemKind::Scrap => LibraryKind::Scrap,
        LibraryItemKind::Bookmark => LibraryKind::Bookmark,
        _ => return None,
    };
    has_groups(kind).then_some(kind)
}

fn media(item: &LibraryItem, meta: &str, cx: &mut App) -> LibraryCardMedia {
    if is_document(item) {
        return LibraryCardMedia::Document;
    }
    // G-ds: `BlockScrap` (the block rendered live in the card) needs the context-free
    // `chat::answers` entry; a block scrap shows the document placeholder until it exists.
    if item.block.is_some() {
        return LibraryCardMedia::Document;
    }
    if let Some(src) = library_image(item, cx) {
        return LibraryCardMedia::Image { src };
    }
    if item.kind == LibraryItemKind::Bookmark {
        let text = meta.split(" · ").next().unwrap_or(&item.url);
        return LibraryCardMedia::Quote {
            text: text.to_owned().into(),
        };
    }
    LibraryCardMedia::Document
}

impl LibraryPage {
    /// `LibraryItemCard`
    pub(crate) fn item_card(
        &self,
        item: &LibraryItem,
        view: &LibraryView,
        picked: &[LibraryItem],
        selection: Option<CardSelection>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let words = get(cx);
        let meta = item_meta(item, words.lang());
        let page = cx.entity();
        let id = SharedString::from(format!("library-item-{}", item.id));
        let tags: Vec<SharedString> = item
            .tags
            .iter()
            .flatten()
            .cloned()
            .map(SharedString::from)
            .collect();
        let mut card = LibraryCard::new(
            id.clone(),
            media(item, &meta, cx),
            SharedString::from(item.title.clone()),
        )
        .meta(meta)
        .tag(kind_tag(item, words))
        .tags(tags)
        .menu(Self::card_menu(item, &id, &page, words))
        .dragging(cx.has_active_drag() && self.drag.lifted.contains(&item.id))
        .on_open(open_handler(&page, item, view, selection));
        if let Some(selection) = selection {
            let (select, item) = (page.clone(), item.clone());
            card = card
                .selected(selection.selected)
                .selection_mode(selection.mode)
                .select_label(words.select)
                .on_selected_change(move |on, event: &ClickEvent, _, cx| {
                    let shift = event.modifiers().shift;
                    select.update(cx, |page, cx| page.select(&item, on, shift, cx));
                });
        }
        if self.editing.as_deref() == Some(item.id.as_str()) {
            card = card.editing(Self::rename_field(item, &page, words));
        }
        let name = if is_document(item) {
            "library-document-card".to_owned()
        } else {
            format!("library-item-{}", item.id)
        };
        let items = match selection {
            Some(CardSelection { selected: true, .. }) => picked.to_vec(),
            _ => vec![item.clone()],
        };
        anchor(div().id(id).w_full(), &name)
            .on_drag(CardDrag { items }, move |drag, _, _, cx| {
                page.update(cx, |page, cx| page.lift(drag, cx));
                card_ghost(drag, cx)
            })
            .child(card)
            .into_any_element()
    }

    /// `editing`: the title as a name field; Enter renames, Escape leaves.
    fn rename_field(item: &LibraryItem, page: &Entity<Self>, words: &Words) -> LibraryCardEditing {
        let (commit, cancel, item) = (page.clone(), page.clone(), item.clone());
        LibraryCardEditing::new(
            item.title.clone(),
            words.name,
            move |title: &str, _, cx: &mut App| {
                commit.update(cx, |page, cx| {
                    page.editing = None;
                    cx.notify();
                });
                rename_item(&item, title, cx);
            },
            move |_, cx: &mut App| {
                cancel.update(cx, |page, cx| {
                    page.editing = None;
                    cx.notify();
                });
            },
        )
    }

    /// The ⋯ menu of a card.
    fn card_menu(
        item: &LibraryItem,
        id: &SharedString,
        page: &Entity<Self>,
        words: &'static Words,
    ) -> AnyElement {
        let mut menu =
            OverflowActionMenu::new(SharedString::from(format!("{id}-menu")), words.more);
        let rename = {
            let (page, item_id) = (page.clone(), item.id.clone());
            OverflowItem::new(words.rename)
                .icon(Icon::PencilLine)
                .on_select(move |_, cx| {
                    page.update(cx, |page, cx| {
                        page.editing = Some(item_id.clone());
                        cx.notify();
                    });
                })
        };
        menu = menu.item(rename);
        if let Some(kind) = group_kind(item) {
            let (page, item) = (page.clone(), item.clone());
            menu = menu.item(
                OverflowItem::new(format!("{}…", words.groups(kind).move_to))
                    .icon(Icon::Folder)
                    .on_select(move |_, cx| {
                        let items = vec![item.clone()];
                        page.update(cx, |_, cx| {
                            LibraryPage::dialog(LibraryDialog::Move { kind, items }, cx);
                        });
                    }),
            );
        }
        menu = menu.item(menu_dialog(page, item, words));
        menu = menu.item(menu_attach(page, item, words));
        if item.block.is_some()
            || is_document(item)
            || item.file.is_some()
            || item.output.is_some()
            || has_web_source(item)
        {
            menu = menu.item(menu_source(page, item, words));
        }
        menu.item(menu_delete(page, item, words)).into_any_element()
    }

    /// Opens one of the 서랍's dialogs.
    pub(crate) fn dialog(dialog: LibraryDialog, cx: &mut Context<Self>) {
        open_dialog(dialog, cx);
    }

    /// The card menu's Delete: a Library change on success.
    fn delete_item(id: String, cx: &mut Context<Self>) {
        fetch(
            cx,
            move |client| async move { client.delete_library(&id).await },
            |page, result: Result<Value, Error>, cx| match result {
                Ok(_) => page
                    .ctx
                    .live
                    .update(cx, |live, cx| live.bump(Topic::Library, cx)),
                Err(_) => {
                    let failed = get(cx).failed;
                    toast::show(cx, Toast::error(failed));
                }
            },
        );
    }
}

/// `open`: a click opens the item; with a modifier inside a selection it toggles the card.
fn open_handler(
    page: &Entity<LibraryPage>,
    item: &LibraryItem,
    view: &LibraryView,
    selection: Option<CardSelection>,
) -> impl Fn(&ClickEvent, &mut Window, &mut App) + 'static {
    let (page, item, view) = (page.clone(), item.clone(), view.clone());
    move |event, _, cx| {
        let modifier = event.modifiers();
        page.update(cx, |page, cx| {
            if let (true, Some(selection)) = (
                modifier.platform || modifier.control || modifier.shift,
                selection,
            ) {
                page.select(&item, !selection.selected, modifier.shift, cx);
            } else if item.kind == LibraryItemKind::Scrap {
                open_detail(&page.ctx, item.clone(), &view, cx);
            } else {
                open_library_item(&page.ctx, &item, false, cx);
            }
        });
    }
}

/// Edit tags…
fn menu_dialog(page: &Entity<LibraryPage>, item: &LibraryItem, words: &Words) -> OverflowItem {
    let (page, item) = (page.clone(), item.clone());
    OverflowItem::new(words.edit_tags)
        .icon(Icon::TagIcon)
        .on_select(move |_, cx| {
            let item = item.clone();
            page.update(cx, |_, cx| {
                LibraryPage::dialog(LibraryDialog::TagItems(vec![item]), cx);
            });
        })
}

/// Attach to chat: the attach dialog opens beside the page.
fn menu_attach(page: &Entity<LibraryPage>, item: &LibraryItem, words: &Words) -> OverflowItem {
    let (page, item) = (page.clone(), item.clone());
    OverflowItem::new(words.attach)
        .icon(Icon::MessageSquarePlus)
        .on_select(move |_, cx| {
            let item = item.clone();
            page.update(cx, |page, cx| {
                page.attachment = Some(item);
                cx.notify();
            });
        })
}

/// Open source / Go to chat: `openLibraryItem(item, true)`.
fn menu_source(page: &Entity<LibraryPage>, item: &LibraryItem, words: &Words) -> OverflowItem {
    let label = if goes_to_chat(item) {
        words.go_to_chat
    } else {
        words.open_source
    };
    let (page, item) = (page.clone(), item.clone());
    OverflowItem::new(label)
        .icon(Icon::Popup)
        .on_select(move |_, cx| {
            page.update(cx, |page, cx| open_library_item(&page.ctx, &item, true, cx));
        })
}

/// Delete
fn menu_delete(page: &Entity<LibraryPage>, item: &LibraryItem, words: &Words) -> OverflowItem {
    let (page, id) = (page.clone(), item.id.clone());
    OverflowItem::new(words.delete_item)
        .icon(Icon::Trash2)
        .destructive()
        .on_select(move |_, cx| {
            let id = id.clone();
            page.update(cx, |_, cx| LibraryPage::delete_item(id, cx));
        })
}
