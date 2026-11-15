//! AddressSuggestions.tsx: the field keeps focus while its list handles navigation keys.
use super::{
    area::{AreaState, result},
    engine::TabId,
    model::BrowserState,
};
use crate::ui::{
    i18n::browser::BrowserStrings, manage::library::detail::api, source::fetch::fetch,
    widgets::anchor,
};
use butler_ds::ui::{
    blocks::{
        address_field::AddressField,
        suggestion_list::{SuggestionKind, SuggestionList, SuggestionRow},
    },
    popover::{Density, Popover, PopoverContent, Width},
    toast::{self, Toast},
};
use gpui::{
    AnyElement, App, Entity, IntoElement as _, KeyDownEvent, ParentElement as _, SharedString,
    Styled as _, Window, div,
};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Suggestion {
    url: String,
    title: String,
    bookmark_id: Option<String>,
}
#[derive(Default)]
pub(super) struct Suggestions {
    query: String,
    items: Vec<Suggestion>,
    active: Option<usize>,
    dismissed: bool,
    generation: u64,
}
impl Suggestions {
    pub(super) fn reset(&mut self) {
        *self = Self {
            generation: self.generation + 1,
            ..Self::default()
        };
    }
    fn open(&self) -> bool {
        !self.items.is_empty() && !self.dismissed
    }
}
#[derive(Deserialize)]
struct Page {
    items: Vec<Suggestion>,
}
fn query(state: &Entity<AreaState>, q: String, cx: &mut App) {
    state.update(cx, |state, cx| {
        let s = &mut state.suggestions;
        s.query.clone_from(&q);
        s.generation += 1;
        s.active = None;
        s.dismissed = false;
        let generation = s.generation;
        if q.trim().is_empty() {
            s.items.clear();
            cx.refresh_windows();
            return;
        }
        fetch(
            cx,
            move |client| async move { client.get_browser_history_suggestions(&q).await },
            move |state, result: Result<Page, _>, cx| {
                if state.suggestions.generation == generation {
                    if let Ok(page) = result {
                        state.suggestions.items = page.items;
                    }
                    cx.refresh_windows();
                }
            },
        );
        cx.refresh_windows();
    });
}
fn choose(state: &Entity<AreaState>, tab: &TabId, url: &str, window: &mut Window, cx: &mut App) {
    let value = cx.global_mut::<BrowserState>().navigate(tab, url);
    result(&value, cx);
    state.update(cx, |state, cx| {
        state.editing = false;
        state.suggestions.reset();
        state.focus.focus(window, cx);
    });
}
fn remove(state: &Entity<AreaState>, item: Suggestion, cx: &mut App) {
    let state = state.clone();
    let delete_url = move |reply: Result<Value, _>, cx: &mut App| {
        if reply.is_err() {
            toast::show(cx, Toast::error(BrowserStrings::get(cx).failed));
            return;
        }
        api::send(
            cx,
            move |client| async move {
                client
                    .delete_browser_history_url(&json!({"url":item.url}))
                    .await
            },
            move |reply: Result<Value, _>, cx| {
                if reply.is_err() {
                    toast::show(cx, Toast::error(BrowserStrings::get(cx).failed));
                }
                let q = state.read(cx).suggestions.query.clone();
                query(&state, q, cx);
            },
        );
    };
    if let Some(id) = item.bookmark_id {
        api::delete_item(cx, id, delete_url);
    } else {
        delete_url(Ok(Value::Null), cx);
    }
}

fn key(
    state: &Entity<AreaState>,
    tab: Option<&TabId>,
    event: &KeyDownEvent,
    window: &mut Window,
    cx: &mut App,
) -> bool {
    let s = &state.read(cx).suggestions;
    if !state.read(cx).editing || !s.open() {
        return false;
    }
    let active = s.active;
    let count = s.items.len();
    match event.keystroke.key.as_str() {
        "down" | "up" => {
            let next = if event.keystroke.key == "down" {
                match active {
                    None => Some(0),
                    Some(i) if i + 1 < count => Some(i + 1),
                    _ => None,
                }
            } else {
                match active {
                    None => Some(count - 1),
                    Some(0) => None,
                    Some(i) => Some(i - 1),
                }
            };
            state.update(cx, |state, _| state.suggestions.active = next);
        }
        "enter" if active.is_some() && tab.is_some() => {
            if let (Some(tab), Some(item)) = (tab, active.and_then(|i| s.items.get(i)).cloned()) {
                choose(state, tab, &item.url, window, cx);
            }
        }
        "delete" if event.keystroke.modifiers.shift && active.is_some() => {
            if let Some(item) = active.and_then(|i| s.items.get(i)).cloned() {
                remove(state, item, cx);
            }
        }
        "escape" => {
            state.update(cx, |state, _| {
                state.suggestions.dismissed = true;
                state.suggestions.active = None;
            });
        }
        _ => return false,
    }
    cx.stop_propagation();
    cx.refresh_windows();
    true
}
pub(super) fn field(
    field: AddressField,
    state: &Entity<AreaState>,
    tab: Option<&TabId>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let input = state.clone();
    let keys = state.clone();
    let key_tab = tab.cloned();
    let field = field
        .on_input(move |q, _, cx| query(&input, q, cx))
        .on_key(move |event, window, cx| key(&keys, key_tab.as_ref(), event, window, cx));
    let dismissed = state.clone();
    let open = state.read(cx).editing && state.read(cx).suggestions.open();
    let popover = Popover::new("browser-address-suggestions", window, cx)
        .open(open)
        .on_open_change(move |open, _, cx| {
            if !open {
                dismissed.update(cx, |s, _| s.suggestions.dismissed = true);
                cx.refresh_windows();
            }
        });
    let s = &state.read(cx).suggestions;
    let tab = tab.cloned();
    let mut list = SuggestionList::new();
    for (i, item) in s.items.iter().enumerate() {
        let (state, tab, url) = (state.clone(), tab.clone(), item.url.clone());
        let id = SharedString::from(format!("browser-suggestion-{i}"));
        let row = SuggestionRow::new(id.clone(), item.url.clone(), move |window, cx| {
            if let Some(tab) = &tab {
                choose(&state, tab, &url, window, cx);
            }
        })
        .title(item.title.clone())
        .query(s.query.clone())
        .active(s.active == Some(i))
        .kind(if item.bookmark_id.is_some() {
            SuggestionKind::Bookmark
        } else {
            SuggestionKind::History
        });
        list =
            list.child(anchor(div(), &format!("browser-suggestion-{i}-{}", item.url)).child(row));
    }
    let content = PopoverContent::new()
        .width(Width::Anchor)
        .density(Density::List)
        .child(anchor(div(), "browser-suggestions").child(list));
    div()
        .w_full()
        .child(popover.anchor(field))
        .child(popover.content(content, window, cx))
        .into_any_element()
}
