//! The browser history page (`browser/HistoryPage.tsx`, `HistoryClearDialog.tsx`,
//! `historyApi.ts`).
mod clear;
mod copy;
mod day;

use butler_ds::ui::Icon;
use butler_ds::ui::blocks::empty_line::EmptyLine;
use butler_ds::ui::blocks::history_row::{HistoryGroup, HistoryRow};
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::field::{Field, FieldLabel};
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::layout::{Box as DsBox, Cross, Justify, Space, Stack};
use butler_ds::ui::page_container::{Gutter, PageContainer, PageWidth};
use butler_ds::ui::scroll::ScrollArea;
use butler_ds::ui::switch::Switch;
use butler_ds::ui::text::Input;
use butler_ds::ui::toast::{self, Toast};
use butler_ds::ui::typo::{Tone, Typo};
use butler_shell_client::Error;
use gpui::{
    AnyElement, AnyView, App, AppContext as _, Context, Entity, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, SharedString, Styled as _, Subscription, Window, div,
};
use serde::Deserialize;
use serde_json::{Value, json};

use self::clear::{ClearEvent, HistoryClear};
use self::copy::words;
use super::ManageCtx;
use crate::ui::source::fetch::fetch;
use crate::ui::widgets::anchor;

/// `HistoryVisit` (`historyApi.ts`).
#[derive(Clone, Debug, PartialEq, Deserialize)]
struct Visit {
    id: i64,
    url: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    favicon: String,
    #[serde(rename = "visitTime")]
    time: i64,
    #[serde(rename = "visitedAt", default)]
    visited_at: String,
    #[serde(rename = "conversationId", default)]
    conversation_id: Option<String>,
}

/// `HistoryPageData`
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
struct Items {
    #[serde(default)]
    items: Vec<Visit>,
    #[serde(default)]
    next_cursor: Option<String>,
}

/// `HistoryPage`
pub(crate) fn page(ctx: ManageCtx, window: &mut Window, cx: &mut App) -> AnyView {
    cx.new(|cx| HistoryPage::new(ctx, window, cx)).into()
}

#[expect(
    clippy::struct_excessive_bools,
    reason = "independent view flags: filter, load failure, loading, selection mode, bulk-action busy"
)]
struct HistoryPage {
    ctx: ManageCtx,
    search: SharedString,
    only: bool,
    page: Items,
    failed: bool,
    loading: bool,
    selecting: bool,
    selected: Vec<i64>,
    busy: bool,
    clear: Option<(Entity<HistoryClear>, Subscription)>,
    /// The read the page waits for; an older answer is dropped (`active`).
    read: u64,
}

impl HistoryPage {
    fn new(ctx: ManageCtx, _window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut page = Self {
            ctx,
            search: SharedString::default(),
            only: false,
            page: Items::default(),
            failed: false,
            loading: false,
            selecting: false,
            selected: Vec::new(),
            busy: false,
            clear: None,
            read: 0,
        };
        page.load(None, cx);
        page
    }

    /// The effect on (`search`, `only`, `cursor`, `version`): GET /browser-history. A cursor
    /// appends the next page; none starts over and drops the selection.
    fn load(&mut self, cursor: Option<String>, cx: &mut Context<Self>) {
        if cursor.is_none() {
            self.selected.clear();
        }
        self.read += 1;
        let read = self.read;
        self.loading = true;
        self.failed = false;
        let (search, only, after) = (self.search.to_string(), self.only, cursor.clone());
        fetch(
            cx,
            move |client| async move {
                client
                    .list_browser_history(Some(&search), Some(only), after.as_deref())
                    .await
            },
            move |this: &mut Self, result: Result<Items, Error>, _| {
                if this.read != read {
                    return;
                }
                this.loading = false;
                match result {
                    Ok(next) => {
                        let mut items = if cursor.is_some() {
                            std::mem::take(&mut this.page.items)
                        } else {
                            Vec::new()
                        };
                        items.extend(next.items);
                        this.page = Items {
                            items,
                            next_cursor: next.next_cursor,
                        };
                    }
                    Err(_) => this.failed = true,
                }
            },
        );
    }

    /// `remove(ids)`: POST /browser-history/delete in chunks of 1000, then `historyChanged`.
    fn remove(&mut self, ids: Vec<i64>, cx: &mut Context<Self>) {
        self.busy = true;
        cx.notify();
        fetch(
            cx,
            move |client| async move {
                for chunk in ids.chunks(1000) {
                    client
                        .delete_browser_history(&json!({ "ids": chunk }))
                        .await?;
                }
                Ok(Value::Null)
            },
            |this: &mut Self, result: Result<Value, Error>, cx| {
                this.busy = false;
                match result {
                    Ok(_) => {
                        this.selecting = false;
                        this.load(None, cx);
                    }
                    Err(_) => {
                        let copy = words(Ds::get(cx).lang());
                        toast::show(cx, Toast::error(copy.failed));
                    }
                }
            },
        );
    }

    fn stop_selecting(&mut self, cx: &mut Context<Self>) {
        self.selecting = false;
        self.selected.clear();
        cx.notify();
    }

    fn toggle(&mut self, id: i64, on: bool, cx: &mut Context<Self>) {
        self.selected.retain(|other| *other != id);
        if on {
            self.selected.push(id);
        }
        cx.notify();
    }

    fn open_clear(&mut self, cx: &mut Context<Self>) {
        let dialog = cx.new(|_| HistoryClear::new());
        let events = cx.subscribe(&dialog, |this, _, event: &ClearEvent, cx| {
            match event {
                ClearEvent::Close => this.clear = None,
                ClearEvent::Cleared => this.load(None, cx),
            }
            cx.notify();
        });
        self.clear = Some((dialog, events));
        cx.notify();
    }

    /// The search field, the Butler-only switch and the select / clear buttons.
    fn toolbar(&self, cx: &mut Context<Self>) -> AnyElement {
        let copy = words(Ds::get(cx).lang());
        let me = cx.entity();
        let search = me.clone();
        let input = Input::new("history-search")
            .placeholder(copy.search)
            .value(self.search.clone())
            .on_change(move |text, _, cx| {
                let text = SharedString::from(text.to_string());
                search.update(cx, |this, cx| {
                    this.search = text;
                    this.load(None, cx);
                    cx.notify();
                });
            });
        let only = me.clone();
        // `<Field><FieldLabel>…</FieldLabel><Switch/></Field>`: the label over the switch.
        let filter = Field::new("history-only-field")
            .child(FieldLabel::new().child(SharedString::from(copy.butler_only)))
            .child(
                Switch::new("history-only")
                    .checked(self.only)
                    .on_checked_change(move |checked, _, cx| {
                        only.update(cx, |this, cx| {
                            this.only = checked;
                            this.load(None, cx);
                            cx.notify();
                        });
                    }),
            );
        let buttons = if self.selecting {
            self.selection_buttons(&me, copy)
        } else {
            let (select, clear) = (me.clone(), me);
            button::container(Size::Sm)
                .child({
                    let button = Button::new("history-select")
                        .size(Size::Sm)
                        .variant(Variant::Ghost)
                        .text(copy.select)
                        .on_click(move |_, _, cx| {
                            select.update(cx, |this, cx| {
                                this.selecting = true;
                                cx.notify();
                            });
                        });
                    if self.page.items.is_empty() {
                        button.disabled()
                    } else {
                        button
                    }
                })
                .child(
                    Button::new("history-clear")
                        .size(Size::Sm)
                        .variant(Variant::Outline)
                        .text(copy.clear)
                        .on_click(move |_, _, cx| {
                            clear.update(cx, Self::open_clear);
                        }),
                )
                .into_any_element()
        };
        Stack::new()
            .gap(Space::Md)
            .child(input)
            .child(
                Stack::row()
                    .justify(Justify::Between)
                    .cross(Cross::End)
                    .gap(Space::Sm)
                    .child(filter)
                    .child(buttons),
            )
            .into_any_element()
    }

    /// The selecting state: the count, Cancel and the destructive Delete.
    fn selection_buttons(&self, me: &Entity<Self>, copy: &copy::Words) -> AnyElement {
        let (cancel, remove) = (me.clone(), me.clone());
        let ids = self.selected.clone();
        let mut delete = Button::new("history-delete-selected")
            .size(Size::Sm)
            .variant(Variant::Destructive)
            .text(copy.remove)
            .on_click(move |_, _, cx| {
                let ids = ids.clone();
                remove.update(cx, |this, cx| this.remove(ids, cx));
            });
        if self.busy || self.selected.is_empty() {
            delete = delete.disabled();
        }
        Stack::row()
            .cross(Cross::Center)
            .gap(Space::Md)
            .child(
                Typo::caption((copy.selected)(self.selected.len()))
                    .tone(Tone::Secondary)
                    .tabular(),
            )
            .child(
                button::container(Size::Sm)
                    .child(
                        Button::new("history-cancel-select")
                            .size(Size::Sm)
                            .variant(Variant::Ghost)
                            .text(copy.cancel)
                            .on_click(move |_, _, cx| {
                                cancel.update(cx, Self::stop_selecting);
                            }),
                    )
                    .child(delete),
            )
            .into_any_element()
    }

    /// The row's trailing buttons: Open conversation (a visit made for a chat) and Delete.
    fn actions(&self, visit: &Visit, copy: &copy::Words, me: &Entity<Self>) -> AnyElement {
        let mut actions = button::container(Size::IconSm);
        if let Some(chat) = visit.conversation_id.clone() {
            let open = me.clone();
            actions = actions.child(
                IconButton::new(format!("history-chat-{}", visit.id), copy.open_conversation)
                    .glyph(Icon::MessageSquare)
                    .on_click(move |_, _, cx| {
                        let chat = SharedString::from(chat.clone());
                        open.update(cx, |this, cx| this.ctx.open_session(chat, cx));
                    }),
            );
        }
        let (id, remove) = (visit.id, me.clone());
        let name = if visit.title.is_empty() {
            &visit.url
        } else {
            &visit.title
        };
        let mut delete = IconButton::new(
            format!("history-remove-{id}"),
            format!("{}: {name}", copy.remove),
        )
        .glyph(Icon::Trash2)
        .on_click(move |_, _, cx| {
            remove.update(cx, |this, cx| this.remove(vec![id], cx));
        });
        if self.busy {
            delete = delete.disabled();
        }
        actions.child(delete).into_any_element()
    }

    /// The visits grouped by day, in the order they came (`groups`).
    fn groups(&self, lang: butler_ds::ui::context::Lang, me: &Entity<Self>) -> Vec<AnyElement> {
        let copy = words(lang);
        let mut days: Vec<(String, Vec<&Visit>)> = Vec::new();
        for visit in &self.page.items {
            let title = day::day(visit.time, lang, copy);
            match days.iter_mut().find(|(name, _)| *name == title) {
                Some((_, visits)) => visits.push(visit),
                None => days.push((title, vec![visit])),
            }
        }
        days.into_iter()
            .map(|(title, visits)| {
                let rows = visits.into_iter().map(|visit| {
                    let toggle = me.clone();
                    let id = visit.id;
                    let url = visit.url.clone();
                    let row = HistoryRow::new(
                        SharedString::from(id.to_string()),
                        visit.url.clone(),
                        day::time(visit.time, lang),
                    )
                    .title(visit.title.clone())
                    .on_open(move |_, cx| crate::ui::browser::open_link(&url, cx));
                    let row = if visit.favicon.is_empty() {
                        row
                    } else {
                        row.icon_src(visit.favicon.clone())
                    };
                    row.date_time(visit.visited_at.clone())
                        .actions(self.actions(visit, copy, me))
                        .selecting(self.selecting)
                        .selected(self.selected.contains(&id))
                        .on_selected_change(move |on, _, cx| {
                            toggle.update(cx, |this, cx| this.toggle(id, on, cx));
                        })
                });
                HistoryGroup::new(title).children(rows).into_any_element()
            })
            .collect()
    }
}

impl Render for HistoryPage {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let lang = Ds::get(cx).lang();
        let copy = words(lang);
        let me = cx.entity();
        let groups = self.groups(lang, &me);
        let mut column = Stack::new().gap(Space::Xl).child(self.toolbar(cx));
        if !groups.is_empty() {
            column = column.child(Stack::new().gap(Space::Lg).children(groups));
        }
        if self.page.items.is_empty() {
            let message = if self.failed {
                copy.failed
            } else if self.loading {
                copy.loading
            } else {
                copy.empty
            };
            column = column.child(EmptyLine::new(message));
        }
        if let Some(cursor) = self.page.next_cursor.clone() {
            let more = me.clone();
            let mut button = Button::new("history-load-more")
                .size(Size::Sm)
                .text(copy.load_more)
                .on_click(move |_, _, cx| {
                    let cursor = cursor.clone();
                    more.update(cx, |this, cx| {
                        this.load(Some(cursor), cx);
                        cx.notify();
                    });
                });
            if self.loading {
                button = button.disabled();
            }
            column = column.child(button);
        }
        let body = PageContainer::new()
            .width(PageWidth::Narrow)
            .gutter(Gutter::Xl)
            .child(DsBox::new().padding_y(Space::Xl).child(column));
        let page = ScrollArea::new("history-scroll").fill().child(body);
        let page = anchor(
            div()
                .id("history-page")
                .size_full()
                .flex()
                .flex_col()
                .child(page),
            "history-page",
        );
        div()
            .size_full()
            .child(page)
            .children(self.clear.as_ref().map(|(dialog, _)| dialog.clone()))
    }
}
