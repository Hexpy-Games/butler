//! Bookmark lookup and paged menu, using the library's existing client and write bus.
use super::{area::AreaState, model::Tab};
use crate::ui::{
    Icon,
    i18n::browser::BrowserStrings,
    manage::{
        self, LibraryView, Topic, View,
        library::{
            detail::api,
            types::{LibraryItem, LibraryPageData},
        },
    },
    source::fetch::fetch,
};
use butler_ds::ui::{
    dropdown_menu::{DropdownMenu, DropdownMenuContent, Entry, Item, Sub},
    icon_button::IconButton,
    toast::{self, Toast},
};
use gpui::{AnyElement, App, Entity, IntoElement as _, ParentElement as _, Window, div};
use serde_json::{Value, json};

#[derive(Default)]
pub(super) struct Bookmarks {
    pub(super) current: Option<LibraryItem>,
    lookup: Option<(String, u64)>,
    items: Vec<LibraryItem>,
    next: Option<String>,
    version: Option<u64>,
    loading: bool,
    failed: bool,
}
fn revision(cx: &App) -> u64 {
    manage::window_ctx(cx).map_or(0, |ctx| ctx.live.read(cx).revision(&Topic::Library))
}
pub(super) fn lookup(state: &Entity<AreaState>, url: &str, cx: &mut App) {
    let key = (url.to_owned(), revision(cx));
    if state.read(cx).bookmarks.lookup.as_ref() == Some(&key) {
        return;
    }
    state.update(cx, |s, cx| {
        s.bookmarks.current = None;
        s.bookmarks.lookup = Some(key.clone());
        if url.is_empty() {
            return;
        }
        let request = key.clone();
        fetch(
            cx,
            move |client| async move {
                client
                    .list_library(
                        None,
                        None,
                        None,
                        Some(&request.0),
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
            move |s, reply: Result<Value, _>, cx| {
                if s.bookmarks.lookup.as_ref() == Some(&key) {
                    s.bookmarks.current = reply
                        .ok()
                        .and_then(|v| serde_json::from_value(v["item"].clone()).ok());
                    cx.refresh_windows();
                }
            },
        );
    });
}
pub(super) fn toggle(state: &Entity<AreaState>, tab: &Tab, cx: &mut App) {
    let current = state.read(cx).bookmarks.current.clone();
    let done = |reply: Result<Value, _>, cx: &mut App| {
        if reply.is_err() {
            toast::show(cx, Toast::error(BrowserStrings::get(cx).failed));
        }
        cx.refresh_windows();
    };
    if let Some(item) = current {
        api::delete_item(cx, item.id, done);
    } else {
        let body = json!({"id": uuid::Uuid::new_v4().to_string(), "kind": "bookmark", "title": if tab.title.is_empty() { &tab.url } else { &tab.title }, "url": tab.url, "capturedAt": chrono::Utc::now().to_rfc3339()});
        api::send(
            cx,
            move |client| async move { client.save_library(&body).await },
            done,
        );
    }
}
fn load(state: &Entity<AreaState>, cursor: Option<String>, cx: &mut App) {
    let version = revision(cx);
    state.update(cx, |s, cx| {
        s.bookmarks.version = Some(version);
        s.bookmarks.loading = true;
        s.bookmarks.failed = false;
        let append = cursor.is_some();
        if !append {
            s.bookmarks.items.clear();
            s.bookmarks.next = None;
        }
        fetch(
            cx,
            move |client| async move {
                client
                    .list_library(
                        Some("bookmark"),
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
            move |s, reply: Result<LibraryPageData, _>, cx| {
                if s.bookmarks.version != Some(version) {
                    return;
                }
                s.bookmarks.loading = false;
                match reply {
                    Ok(page) => {
                        if append {
                            s.bookmarks.items.extend(page.items);
                        } else {
                            s.bookmarks.items = page.items;
                        }
                        s.bookmarks.next = page.next_cursor;
                    }
                    Err(_) => s.bookmarks.failed = true,
                }
                cx.refresh_windows();
            },
        );
    });
}
fn entry(item: &LibraryItem) -> Item {
    let url = item.url.clone();
    Item::new(item.title.clone()).on_select(move |_, cx| super::open_link(&url, cx))
}
pub(super) fn menu(state: &Entity<AreaState>, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = BrowserStrings::get(cx);
    let menu = DropdownMenu::new("browser-bookmarks", window, cx);
    if menu.is_open(cx) && state.read(cx).bookmarks.version != Some(revision(cx)) {
        load(state, None, cx);
    }
    let trigger = menu.trigger(|toggle| {
        IconButton::new("browser-bookmarks-trigger", c.bookmarks)
            .glyph(Icon::Bookmark)
            .menu_trigger()
            .on_click(toggle.on_click())
            .into_any_element()
    });
    let data = &state.read(cx).bookmarks;
    let mut content = DropdownMenuContent::new();
    let mut folders = Vec::new();
    for item in &data.items {
        let folder = item.folder.as_deref().unwrap_or("");
        if !folders.contains(&folder) {
            folders.push(folder);
        }
    }
    for folder in folders {
        let items = data
            .items
            .iter()
            .filter(|i| i.folder.as_deref().unwrap_or("") == folder);
        if folder.is_empty() {
            for item in items {
                content = content.child(entry(item));
            }
        } else {
            let mut sub = Sub::new(folder.to_owned()).icon(Icon::Folder);
            for item in items {
                sub = sub.child(entry(item));
            }
            content = content.child(sub);
        }
    }
    if !data.loading && data.items.is_empty() {
        content = content.child(
            Item::new(if data.failed {
                c.failed
            } else {
                c.empty_library
            })
            .disabled(),
        );
    }
    if let Some(cursor) = data.next.clone() {
        let state = state.clone();
        let mut more = Item::new(c.load_more)
            .keep_open()
            .on_select(move |_, cx| load(&state, Some(cursor.clone()), cx));
        if data.loading {
            more = more.disabled();
        }
        content = content.child(more);
    }
    content = content
        .child(Entry::separator())
        .child(Item::new(c.manage_bookmarks).on_select(|_, cx| {
            if let Some(ctx) = manage::window_ctx(cx) {
                ctx.set_view(View::Library(LibraryView::default()), cx);
            }
        }));
    div()
        .child(trigger)
        .child(menu.content(content, window, cx))
        .into_any_element()
}
