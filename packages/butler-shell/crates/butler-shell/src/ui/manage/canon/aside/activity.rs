//! `EpicActivity.tsx`: the epic's activity feed, newest first, older pages on request.
use std::collections::BTreeMap;

use butler_ds::ui::blocks::activity_feed::{ActivityFeed, ActivityFeedItem};
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Justify, Space, Stack};
use butler_ds::ui::toast::{self, Toast};
use butler_ds::ui::typo::{Typo, Wrap};
use butler_shell_client::Error;
use gpui::{
    AnyElement, Context, InteractiveElement as _, IntoElement as _, ParentElement as _, div,
    prelude::FluentBuilder as _,
};

use super::copy::{Unit, Words};
use super::inspector::EpicInspector;
use crate::ui::Icon;
use crate::ui::manage::canon::common;
use crate::ui::source::fetch::fetch;
use crate::ui::source::wire::{CanonActivity, CanonActivityPage, EpicDetail};
use crate::ui::widgets::anchor;

/// The pages read so far.
#[derive(Default)]
pub(super) struct Activity {
    rows: Vec<CanonActivity>,
    before: Option<i64>,
    busy: bool,
    started: bool,
}

/// Rows by `seq`, a later copy replacing an earlier one, newest first.
fn merge(rows: &mut Vec<CanonActivity>, more: Vec<CanonActivity>) {
    let mut by_seq: BTreeMap<i64, CanonActivity> =
        rows.drain(..).map(|row| (row.seq, row)).collect();
    by_seq.extend(more.into_iter().map(|row| (row.seq, row)));
    *rows = by_seq.into_values().rev().collect();
}

impl Activity {
    /// The detail's own page: the first one is taken as it is, later ones are merged in.
    pub(super) fn merge_detail(&mut self, detail: &EpicDetail) {
        let incoming = detail.activity.clone().unwrap_or_default();
        if !self.started {
            self.started = true;
            self.rows = incoming;
            self.before = detail.activity_before;
            return;
        }
        let had_rows = !self.rows.is_empty();
        merge(&mut self.rows, incoming);
        if !had_rows {
            self.before = detail.activity_before;
        }
    }
}

/// `Intl.RelativeTimeFormat(locale, { numeric: "auto" })` of a time in ms.
fn relative(at: i64, words: &Words) -> String {
    let seconds = ((at - chrono::Utc::now().timestamp_millis()) as f64 / 1000.).round();
    let (unit, size) = match seconds.abs() {
        s if s < 60. => (Unit::Second, 1.),
        s if s < 3600. => (Unit::Minute, 60.),
        s if s < 86_400. => (Unit::Hour, 3600.),
        _ => (Unit::Day, 86_400.),
    };
    #[expect(
        clippy::cast_possible_truncation,
        reason = "a rounded count of units of a millisecond difference, far inside i64"
    )]
    let value = (seconds / size).round() as i64;
    match (unit, value) {
        (Unit::Second, 0) => words.time.now.to_owned(),
        (Unit::Day, -1) => words.time.yesterday.to_owned(),
        (Unit::Day, 1) => words.time.tomorrow.to_owned(),
        _ => (words.time.format)(value, unit),
    }
}

/// `activityDescription`
fn describe(row: &CanonActivity, words: &Words) -> String {
    match row.kind.as_str() {
        "status" => match (row.from, row.to) {
            (Some(from), Some(to)) => format!("{} → {}", words.status(from), words.status(to)),
            _ => row.summary.clone(),
        },
        "criterion_confirmed" => (words.criterion_activity)(&row.summary, true),
        "criterion_unconfirmed" => (words.criterion_activity)(&row.summary, false),
        "created" => words.created_activity.to_owned(),
        "comment" => row.body.clone().unwrap_or_else(|| row.summary.clone()),
        "proposal_opened" => format!("{} · {}", words.proposal, row.summary),
        "proposal_applied" => words.applied_activity.to_owned(),
        "proposal_declined" => words.declined_activity.to_owned(),
        _ => row.summary.clone(),
    }
}

/// `activityIcon`
fn glyph(kind: &str) -> Icon {
    match kind {
        "comment" => Icon::MessageSquare,
        "status" => Icon::ArrowRight,
        "created" => Icon::Plus,
        "criterion_confirmed" | "proposal_applied" => Icon::CheckIcon,
        "criterion_unconfirmed" => Icon::Circle,
        "proposal_opened" => Icon::FileText,
        "proposal_declined" => Icon::XIcon,
        _ => Icon::Activity,
    }
}

impl EpicInspector {
    /// `more`: the page before the oldest row.
    fn more_activity(&mut self, cx: &mut Context<Self>) {
        let Some(before) = self.activity.before.filter(|_| !self.activity.busy) else {
            return;
        };
        self.activity.busy = true;
        cx.notify();
        let id = self.epic.to_string();
        fetch(
            cx,
            move |client| async move {
                client
                    .get_canon_activity(&id, Some(&before.to_string()))
                    .await
            },
            |this: &mut Self, result: Result<CanonActivityPage, Error>, cx| {
                this.activity.busy = false;
                match result {
                    Ok(older) => {
                        merge(&mut this.activity.rows, older.activity);
                        this.activity.before = older.activity_before;
                    }
                    Err(_) => {
                        let text = Self::words(cx).request_failed;
                        toast::show(cx, Toast::error(text));
                    }
                }
            },
        );
    }

    /// `EpicActivity`
    pub(super) fn activity_view(&self, cx: &mut Context<Self>) -> AnyElement {
        let words = Self::words(cx);
        let ds = Ds::get(cx);
        let person = common::person_name(cx);
        let items: Vec<ActivityFeedItem> = self
            .activity
            .rows
            .iter()
            .map(|row| {
                ActivityFeedItem::new(
                    row.seq.to_string(),
                    common::actor_label(&row.actor, &person, ds.lang()),
                )
                .icon(icon(glyph(&row.kind), IconSize::Md, ds))
                .meta(relative(row.at, words))
                .description(Typo::text(describe(row, words)).wrap(Wrap::Pre))
            })
            .collect();
        let more = self.activity.before.is_some().then(|| {
            button::container(Size::Sm).justify(Justify::End).child(
                Button::new("epic-activity-more")
                    .size(Size::Sm)
                    .variant(Variant::Ghost)
                    .text(words.more)
                    .when(self.activity.busy, Button::disabled)
                    .on_click(cx.listener(|this, _, _, cx| this.more_activity(cx))),
            )
        });
        let feed = ActivityFeed::new("epic-activity-feed", items)
            .title(words.activity)
            .empty_label(words.no_activity);
        anchor(div().id("canon-activity"), "canon-activity")
            .child(Stack::new().gap(Space::Sm).child(feed).children(more))
            .into_any_element()
    }
}
