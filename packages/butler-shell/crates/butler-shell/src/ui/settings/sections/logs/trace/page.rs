//! `LogTracePage.tsx` and `TraceSummary.tsx`: Settings > Logs > Message trace. The summary,
//! then every step.
use std::collections::HashSet;

use butler_ds::ui::blocks::key_value_row::KeyValueRow;
use butler_ds::ui::blocks::settings_section::{SettingsPage, SettingsSection, SettingsSectionKind};
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::copy_button::CopyButton;
use butler_ds::ui::layout::{Cross, Space, Stack};
use butler_ds::ui::tag::{Size as TagSize, Tag, Tone as TagTone};
use butler_ds::ui::typo::Typo;
use butler_shell_client::Error;
use chrono::{DateTime, Local};
use gpui::{
    AnyElement, ClickEvent, Context, IntoElement, ParentElement as _, Render, SharedString, Window,
};

use super::TraceTarget;
use super::copy::{self, Words};
use super::model::{self, Step, TraceView};
use super::step;
use super::text::format_ms;
use crate::ui::settings::SectionCtx;
use crate::ui::settings::state::{Load, fetch};

/// A trace and its step tree.
struct Loaded {
    trace: TraceView,
    steps: Vec<Step>,
}

/// `LogTracePage`
pub(crate) struct TracePage {
    target: TraceTarget,
    /// `Ready(None)`: the agent has no such trace (`log_not_found`).
    load: Load<Option<Loaded>>,
    /// The rows open now (`TraceSteps` state), as indexes into the steps.
    open: HashSet<usize>,
    /// Which read the page waits for; an older answer is dropped.
    reads: u64,
}

impl TracePage {
    pub(crate) fn new(
        ctx: SectionCtx,
        target: TraceTarget,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let SectionCtx { state } = ctx;
        cx.observe(&state, |_, _, cx| cx.notify()).detach();
        let mut page = Self {
            target,
            load: Load::Loading,
            open: HashSet::new(),
            reads: 0,
        };
        page.reload(cx);
        page
    }

    /// `readTrace`
    fn reload(&mut self, cx: &mut Context<Self>) {
        self.load = Load::Loading;
        self.reads += 1;
        let read = self.reads;
        let target = self.target.clone();
        fetch(
            cx,
            move |client| async move {
                let TraceTarget::Trace(id) = &target;
                client.get_log_trace(id).await
            },
            move |this: &mut Self, result: Result<TraceView, Error>, _| {
                if this.reads == read {
                    this.loaded(result);
                }
            },
        );
    }

    fn loaded(&mut self, result: Result<TraceView, Error>) {
        self.load = match result {
            Ok(trace) => {
                let steps = model::steps(&trace);
                self.open = model::initial_open(&steps);
                Load::Ready(Some(Loaded { trace, steps }))
            }
            Err(Error::Http(404)) => Load::Ready(None),
            Err(_) => Load::Failed,
        };
    }

    fn toggle(&mut self, index: usize, cx: &mut Context<Self>) {
        if !self.open.remove(&index) {
            self.open.insert(index);
        }
        cx.notify();
    }

    /// The visible rows, under the axis.
    // CARVE-OUT(G-span): React puts a SpanAxis (the trace's total on a shared time scale) above
    // the rows; the rows keep their start and length as text.
    fn rows(&self, loaded: &Loaded, copy: &'static Words, cx: &Context<Self>) -> AnyElement {
        let Loaded { trace, steps } = loaded;
        let rows = model::visible(steps, &self.open).into_iter().map(|index| {
            let toggle = cx.listener(move |this, _: &ClickEvent, _, cx| this.toggle(index, cx));
            step::row(
                copy,
                trace,
                steps,
                index,
                self.open.contains(&index),
                toggle,
            )
        });
        Stack::new()
            .gap(Space::None)
            .children(rows)
            .into_any_element()
    }
}

impl Render for TracePage {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let copy = copy::get(cx);
        let mut page = SettingsPage::new().labels(SectionCtx::labels(cx));
        let mut steps =
            SettingsSection::new("trace-steps", SettingsSectionKind::List, copy.steps_title)
                .state(self.load.state(Option::is_none))
                .on_retry(cx.listener(|this, _, _, cx| this.reload(cx)))
                .error_message(copy.load_failed)
                .empty_message(copy.not_found);
        if let Load::Ready(Some(loaded)) = &self.load {
            page = page.section(summary(copy, &loaded.trace, &loaded.steps, cx));
            if loaded.trace.truncated {
                steps = steps.description(copy.partial);
            }
            steps = steps.child(self.rows(loaded, copy, cx));
        }
        page.section(steps)
    }
}

/// `TraceSummary`: result and retries, total time, model, start, chat and the trace ID.
fn summary(
    copy: &'static Words,
    trace: &TraceView,
    steps: &[Step],
    cx: &Context<TracePage>,
) -> SettingsSection {
    let failed = trace.outcome == "error";
    let retries = model::retry_count(steps);
    let result = Stack::row()
        .cross(Cross::Center)
        .gap(Space::Xs)
        .child(if failed {
            Tag::new("trace-outcome", copy.outcome_error)
                .size(TagSize::Sm)
                .tone(TagTone::Danger)
                .into_any_element()
        } else {
            Typo::text(copy.outcome_ok).into_any_element()
        })
        .children((retries > 0).then(|| {
            let lead = if failed { "" } else { "· " };
            Typo::text(format!("{lead}{}", copy.retries(retries)))
        }));
    let [result_label, duration, model_label, started, chat, trace_id] = copy.fields;
    let mut section =
        SettingsSection::new("trace-summary", SettingsSectionKind::Info, copy.summary)
            .child(KeyValueRow::new(result_label, "").value_element(result))
            .child(KeyValueRow::new(
                duration,
                format_ms(copy, trace.duration_ms),
            ));
    if let Some(model) = &trace.model {
        section = section.child(KeyValueRow::new(model_label, model.clone()));
    }
    if let Some(at) = &trace.started_at {
        let lang = Ds::get(cx).lang();
        section = section.child(KeyValueRow::new(started, format_started(at, lang)));
    }
    // CARVE-OUT(shell session list): React shows the chat's title from the navigation store; the
    // settings page has no session list, so the chat ID shows (React's fallback).
    if let Some(id) = &trace.chat_id {
        section = section.child(KeyValueRow::new(chat, id.clone()));
    }
    section.child(KeyValueRow::new(trace_id, "").value_element(trace_id_value(copy, trace)))
}

/// The 32-character ID shows its ends; the copy button copies all of it.
fn trace_id_value(copy: &Words, trace: &TraceView) -> AnyElement {
    let id = &trace.trace_id;
    let tail: String = id
        .chars()
        .skip(id.chars().count().saturating_sub(6))
        .collect();
    let head: String = id.chars().take(8).collect();
    Stack::row()
        .cross(Cross::Center)
        .gap(Space::Xs)
        .child(Typo::code(format!("{head}…{tail}")))
        .child(CopyButton::new("trace-id-copy", copy.copy_id, copy.copied).text(id.clone()))
        .into_any_element()
}

/// "10월 18일 14:02:31" in the reader's locale.
fn format_started(at: &str, lang: Lang) -> SharedString {
    let Ok(date) = DateTime::parse_from_rfc3339(at) else {
        return at.to_owned().into();
    };
    let local = date.with_timezone(&Local);
    let pattern = match lang {
        Lang::Ko => "%-m월 %-d일 %H:%M:%S",
        Lang::En => "%B %-d, %H:%M:%S",
    };
    local.format(pattern).to_string().into()
}
