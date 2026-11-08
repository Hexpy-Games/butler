//! `UsageSessionSelect.tsx`: the chat the page is scoped to, picked from a searchable list.
use butler_ds::ui::blocks::filtered_select_popover::{Filter, FilteredSelectPopover, Group, Item};
use butler_ds::ui::context::Ds;
use butler_ds::ui::popover::{Density, Popover, PopoverContent};
use butler_ds::ui::select_button::{SelectButton, Size};
use butler_ds::ui::tooltip::Align;
use gpui::{AnyElement, Context, IntoElement as _, ParentElement as _, SharedString, Window, div};

use super::UsagePage;
use super::copy::{Words, words};
use super::format::time_of_ms;
use super::wire::TopSession;
use crate::ui::composer::context::timeline::usage_tokens;
use crate::ui::composer::context::usage::now_ms;

/// `usageKind`: other work is named by its kind.
pub(super) fn kind_label(kind: &str, words: &Words) -> &'static str {
    match kind {
        "schedule" => words.schedule,
        "butler" => words.butler_task,
        _ => words.chats,
    }
}

/// `usageSessionTitle`: untitled conversations read as new chats; other work by its kind.
pub(super) fn session_title(session: Option<&TopSession>, words: &Words) -> String {
    if let Some(title) = session.and_then(|session| session.title.clone()) {
        return title;
    }
    match session {
        Some(session) if session.kind != "chat" => kind_label(&session.kind, words).to_owned(),
        _ => words.new_chat.to_owned(),
    }
}

impl UsagePage {
    pub(super) fn session_select(
        &self,
        sessions: &[TopSession],
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let words = words(Ds::get(cx).lang());
        let page = cx.entity().downgrade();
        let popover = Popover::new("usage-session-picker", window, cx)
            .open(self.picker.open)
            .on_open_change({
                let page = page.clone();
                move |open, _, cx| {
                    let _ = page.update(cx, |this, cx| {
                        this.picker.open = open;
                        cx.notify();
                    });
                }
            });
        let title = match self.session.as_deref() {
            Some(id) => session_title(sessions.iter().find(|item| item.session_id == id), words),
            None => words.all.to_owned(),
        };
        let trigger = popover.trigger_fill(|toggle| {
            SelectButton::new("usage-session-trigger")
                .size(Size::Sm)
                .text(title)
                .on_click(toggle.on_click())
                .into_any_element()
        });
        let body = self.picker_body(sessions, cx);
        let content = popover.content(
            PopoverContent::new()
                .align(Align::Start)
                .density(Density::List)
                .child(body),
            window,
            cx,
        );
        div().child(trigger).child(content).into_any_element()
    }

    /// The list: the search, the kind filters and the chats the two let through.
    fn picker_body(&self, sessions: &[TopSession], cx: &mut Context<Self>) -> AnyElement {
        let lang = Ds::get(cx).lang();
        let words = words(lang);
        let page = cx.entity().downgrade();
        let query = self.picker.query.to_lowercase();
        let kind = self.picker.kind.as_str();
        let now = now_ms();
        let select = {
            let page = page.clone();
            move |id: Option<String>, cx: &mut gpui::App| {
                let _ = page.update(cx, |this, cx| this.set_session(id, cx));
            }
        };
        let mut items = Vec::new();
        if query.is_empty() && kind == "all" {
            let select = select.clone();
            items.push(
                Item::new("all", words.all)
                    .selected(self.session.is_none())
                    .on_select(move |_, cx| select(None, cx)),
            );
        }
        for session in sessions {
            let title = session_title(Some(session), words);
            if (kind != "all" && session.kind != kind) || !title.to_lowercase().contains(&query) {
                continue;
            }
            let mut details = vec![
                usage_tokens(session.total_tokens, lang),
                kind_label(&session.kind, words).to_owned(),
            ];
            details.extend(session.last_used_ms.map(|at| time_of_ms(at, now, lang)));
            let (select, id) = (select.clone(), session.session_id.clone());
            items.push(
                Item::new(session.session_id.clone(), SharedString::from(title))
                    .description(details.join(" · "))
                    .selected(self.session.as_deref() == Some(session.session_id.as_str()))
                    .on_select(move |_, cx| select(Some(id.clone()), cx)),
            );
        }
        let filters = [
            ("all", words.all),
            ("chat", words.chats),
            ("schedule", words.schedule),
            ("butler", words.butler_task),
        ]
        .into_iter()
        .map(|(id, label)| {
            let page = page.clone();
            Filter::new(id, label, move |_, cx| {
                let _ = page.update(cx, |this, cx| {
                    id.clone_into(&mut this.picker.kind);
                    cx.notify();
                });
            })
        })
        .collect();
        let range = [(24, words.day), (168, words.week), (720, words.month)]
            .into_iter()
            .find(|(hours, _)| *hours == self.hours)
            .map_or("", |(_, label)| label);
        FilteredSelectPopover::new(
            "usage-session-list",
            words.chats,
            words.search,
            words.no_matches,
        )
        .search(self.picker.query.clone(), move |query, _, cx| {
            let _ = page.update(cx, |this, cx| {
                query.clone_into(&mut this.picker.query);
                cx.notify();
            });
        })
        .filters(filters, self.picker.kind.clone())
        .groups(vec![Group::new("sessions", words.usage_order, items)])
        .footer(Some((words.picker_footer)(range).into()), Vec::new())
        .results_max_rows(7.)
        .into_any_element()
    }
}
