//! `management/ProjectHistoryPanel.tsx`: what happened in the project, newest first, grouped by day.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::event_timeline::{EventTimeline, EventTimelineItem};
use butler_ds::ui::blocks::nav_row::NavRow;
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Box as Frame, Space, Stack};
use butler_ds::ui::section::Section;
use butler_ds::ui::typo::{Tone, Typo, Wrap};
use butler_shell_client::Error;
use gpui::{
    ClickEvent, Context, InteractiveElement as _, IntoElement, ParentElement as _, Render,
    SharedString, Window, div,
};

use super::copy::{Words, words};
use super::docs::{from_source, loaded_count, remember_count, retry_notice};
use super::format;
use crate::ui::manage::dashboard::DashboardCtx;
use crate::ui::source::fetch::fetch;
use crate::ui::source::wire::{DashboardHistoryEvent, DashboardHistoryPage, DashboardHistoryReady};
use crate::ui::widgets::anchor;

const PAGE: u32 = 50;

/// `ProjectHistoryPanel`
pub(crate) struct HistoryPanel {
    ctx: DashboardCtx,
    page: Option<DashboardHistoryPage>,
    error: bool,
    /// The first read keeps reading until the rows the panel last showed are back.
    fill: bool,
    request: u64,
}

impl HistoryPanel {
    pub(crate) fn new(ctx: DashboardCtx, _window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut panel = Self {
            ctx,
            page: None,
            error: false,
            fill: true,
            request: 0,
        };
        panel.load(None, cx);
        panel
    }

    /// One read: the first page, or the page after `cursor`.
    fn load(&mut self, cursor: Option<String>, cx: &mut Context<Self>) {
        self.request += 1;
        let request = self.request;
        self.error = false;
        let append = cursor.is_some();
        let project = self.ctx.project.to_string();
        fetch(
            cx,
            move |client| async move {
                client
                    .get_project_dashboard_history(
                        &project,
                        cursor.as_deref(),
                        Some(PAGE),
                        None,
                        None,
                    )
                    .await
            },
            move |this: &mut Self, result: Result<DashboardHistoryPage, Error>, cx| {
                this.loaded(request, append, result, cx);
            },
        );
    }

    fn loaded(
        &mut self,
        request: u64,
        append: bool,
        result: Result<DashboardHistoryPage, Error>,
        cx: &mut Context<Self>,
    ) {
        if request != self.request {
            return;
        }
        let Ok(next) = result else {
            self.error = true;
            return;
        };
        self.page = Some(match (append, self.page.take(), next) {
            (
                true,
                Some(DashboardHistoryPage::Ready(old)),
                DashboardHistoryPage::Ready(mut next),
            ) => {
                let mut events = old.events;
                events.append(&mut next.events);
                next.events = events;
                DashboardHistoryPage::Ready(next)
            }
            (_, _, next) => next,
        });
        if let Some(DashboardHistoryPage::Ready(ready)) = &self.page {
            let wanted = loaded_count(cx, &self.ctx.project, "history").unwrap_or(PAGE as usize);
            let more = ready.next_cursor.clone();
            if self.fill
                && ready.events.len() < wanted
                && let Some(cursor) = more
            {
                self.load(Some(cursor), cx);
                return;
            }
            remember_count(cx, &self.ctx.project, "history", ready.events.len());
        }
        self.fill = false;
    }

    fn retry(&mut self, cx: &mut Context<Self>) {
        self.page = None;
        self.fill = true;
        self.load(None, cx);
    }

    fn event(
        &self,
        event: &DashboardHistoryEvent,
        words: &'static Words,
        lang: Lang,
        cx: &Context<Self>,
    ) -> EventTimelineItem {
        let ds = Ds::get(cx);
        let glyph = if event.action == "completed" {
            Icon::CheckCircle2
        } else if event.session.is_some() {
            Icon::MessageSquare
        } else {
            Icon::FileText
        };
        let action = if event.action == "completed" {
            words.recorded_completion
        } else {
            words.action(&event.action)
        };
        let linked = event
            .artifact_count
            .filter(|count| *count > 0)
            .map(|count| (words.linked_results)(count));
        let meta = [
            Some(format::time(&event.at, lang)),
            Some(action.to_owned()),
            linked,
        ]
        .into_iter()
        .flatten()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");
        let select = self.ctx.select.clone();
        let picked = from_source(&self.ctx.project, &event.source, &event.title, &event.at);
        let row = NavRow::new(SharedString::from(event.id.clone()), "")
            .label_element(
                Typo::text(event.title.clone())
                    .line_clamp(2)
                    .wrap(Wrap::Anywhere),
            )
            .multiline()
            .actions(icon(Icon::ChevronRight, IconSize::Md, ds))
            .meta(Typo::caption(meta).tone(Tone::Secondary))
            .on_click(move |_, window, cx| select(picked.clone(), window, cx));
        let mut content = Stack::new().gap(Space::Xs).child(row);
        if let Some(session) = &event.session {
            let open = self.ctx.open_session.clone();
            let id = SharedString::from(session.id.clone());
            content = content.child(
                Frame::new().padding_start(Space::Sm).child(
                    Button::new(SharedString::from(format!("history-session-{}", event.id)))
                        .variant(Variant::Borderless)
                        .size(Size::Xs)
                        .icon_start(icon(Icon::MessageSquare, IconSize::Md, ds))
                        .icon_end(icon(Icon::ChevronRight, IconSize::Md, ds))
                        .text(session.title.clone())
                        .on_click(move |_, window, cx| open(id.clone(), window, cx)),
                ),
            );
        }
        EventTimelineItem::new(icon(glyph, IconSize::Md, ds), content)
    }

    fn groups(
        &self,
        ready: &DashboardHistoryReady,
        words: &'static Words,
        lang: Lang,
        cx: &Context<Self>,
    ) -> Vec<Section> {
        let mut days: Vec<(String, Vec<&DashboardHistoryEvent>)> = Vec::new();
        for event in &ready.events {
            let date = format::long_date(&event.at, lang);
            match days.iter_mut().find(|(day, _)| *day == date) {
                Some((_, events)) => events.push(event),
                None => days.push((date, vec![event])),
            }
        }
        days.into_iter()
            .map(|(date, events)| {
                let timeline = events
                    .into_iter()
                    .fold(EventTimeline::new(), |timeline, event| {
                        timeline.item(self.event(event, words, lang, cx))
                    });
                Section::new(SharedString::from(format!("history-{date}")))
                    .title(date)
                    .child(timeline)
            })
            .collect()
    }

    fn content(
        &self,
        ready: &DashboardHistoryReady,
        words: &'static Words,
        lang: Lang,
        cx: &mut Context<Self>,
    ) -> Stack {
        let mut stack = Stack::new().gap(Space::Xl);
        if ready.ledger_unavailable == Some(true) {
            stack = stack.child(Typo::caption(words.ledger_unavailable));
        }
        stack = stack.children(self.groups(ready, words, lang, cx));
        if ready.events.is_empty() && ready.next_cursor.is_none() {
            stack = stack.child(Typo::body(words.no_history));
        }
        if let Some(cursor) = ready.next_cursor.clone() {
            stack = stack.child(
                Button::new("history-more")
                    .variant(Variant::Borderless)
                    .text(words.load_more)
                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                        this.load(Some(cursor.clone()), cx);
                    })),
            );
        }
        stack
    }
}

impl Render for HistoryPanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let lang = Ds::get(cx).lang();
        let words = words(lang);
        let unavailable =
            self.error || matches!(self.page, Some(DashboardHistoryPage::Unavailable { .. }));
        let body = if unavailable {
            retry_notice(
                "history-retry",
                words.unavailable,
                words,
                cx.listener(|this, _: &ClickEvent, _, cx| this.retry(cx)),
            )
            .into_any_element()
        } else {
            match &self.page {
                Some(DashboardHistoryPage::Ready(ready)) => {
                    self.content(ready, words, lang, cx).into_any_element()
                }
                _ => Typo::body(words.dashboard_loading).into_any_element(),
            }
        };
        anchor(div().id("dashboard-history"), "dashboard-history").child(body)
    }
}
