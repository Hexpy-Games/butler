//! `management/ProjectActivityStatistics.tsx`: the calendar of project activity and the records
//! that changed most.
use std::rc::Rc;

use butler_ds::ui::Icon;
use butler_ds::ui::blocks::activity_heatmap::{ActivityHeatmap, ActivityHeatmapDay};
use butler_ds::ui::blocks::activity_strip::{ActivityStrip, ActivityStripDay};
use butler_ds::ui::blocks::nav_row::NavRow;
use butler_ds::ui::blocks::progress_meter::ProgressMeter;
use butler_ds::ui::button::{Button, Variant};
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{
    Border, Box as Frame, Columns, Grid, Preset, Radius, Responsive, Space, Stack,
};
use butler_ds::ui::section::Section;
use butler_ds::ui::typo::{Typo, Wrap};
use gpui::{ClickEvent, Context, IntoElement, ParentElement as _, Render, SharedString, Window};

use super::sources::{FIRST, MORE, source_list};
use super::{Stats, count, pct};
use crate::ui::manage::dashboard::tabs::copy::words;
use crate::ui::manage::dashboard::tabs::format;
use crate::ui::source::wire::{
    DashboardStatisticActivity, DashboardStatisticBucket, DashboardStatisticSource,
};

/// `ProjectActivityStatistics`
pub(super) struct ActivityStatistics {
    stats: Rc<Stats>,
    selected: Option<SharedString>,
    limit: usize,
    focus_limit: usize,
}

/// A card in React's `Box border="hairline" radius="control" paddingX="lg" paddingY="md"`.
fn card(body: Stack) -> Frame {
    Frame::new()
        .border(Border::Hairline)
        .radius(Radius::Control)
        .padding_x(Space::Lg)
        .padding_y(Space::Md)
        .child(body)
}

fn total(bucket: &DashboardStatisticBucket) -> usize {
    bucket.values.values().map(Vec::len).sum()
}

impl ActivityStatistics {
    pub(super) fn new(stats: Rc<Stats>) -> Self {
        Self {
            stats,
            selected: None,
            limit: FIRST,
            focus_limit: FIRST,
        }
    }

    fn select(&mut self, day: &str, cx: &mut Context<Self>) {
        self.selected = Some(SharedString::from(day.to_owned()));
        self.limit = FIRST;
        cx.notify();
    }

    /// `key count · key count` of one day.
    fn counts(&self, bucket: &DashboardStatisticBucket, cx: &Context<Self>) -> String {
        let words = &words(Ds::get(cx).lang()).stats;
        self.stats
            .data
            .activity
            .keys
            .iter()
            .map(|key| {
                let found = bucket.values.get(key).map_or(0, Vec::len);
                format!("{} {found}", words.label_or(key))
            })
            .collect::<Vec<_>>()
            .join(" · ")
    }

    fn calendar(&self, cx: &mut Context<Self>) -> Section {
        let lang = Ds::get(cx).lang();
        let words = &words(lang).stats;
        let data = &self.stats.data;
        let unknown = !data.ledger_history_available && !data.session_history_available;
        let days = data.activity.buckets.iter().map(|day| {
            let summary = if unknown {
                words.unavailable.to_owned()
            } else {
                self.counts(day, cx)
            };
            ActivityHeatmapDay::new(
                day.label.clone(),
                format!("{} · {summary}", format::short_day(&day.label, lang)),
                (!unknown).then(|| u64::try_from(total(day)).unwrap_or(0)),
            )
            .month_label(format::month_short(&day.label, lang))
            .count_label((words.active_items)(total(day)))
        });
        let start = data
            .days
            .first()
            .map_or(0, |day| format::weekday(&day.date));
        let mut heatmap = ActivityHeatmap::new("activity-heatmap", days.collect())
            .aria_label(words.calendar)
            .start_weekday(start)
            .weekday_labels(
                format::weekday_labels(lang)
                    .into_iter()
                    .map(SharedString::from)
                    .collect(),
            )
            .on_select({
                let this = cx.entity();
                move |day, _, cx| this.update(cx, |this, cx| this.select(day, cx))
            });
        if let Some(day) = &self.selected {
            heatmap = heatmap.selected_id(day.clone());
        }
        let mut body = Stack::new().gap(Space::Md);
        if !data.ledger_history_available {
            body = body.child(Typo::caption(words.history_unavailable));
        }
        if !data.session_history_available {
            body = body.child(Typo::caption(words.session_unavailable));
        }
        body = body.child(heatmap);
        if let (Some(first), Some(last)) = (data.days.first(), data.days.last()) {
            body = body.child(Typo::caption(format!(
                "{} — {}",
                format::short_day(&first.date, lang),
                format::short_day(&last.date, lang)
            )));
        }
        let picked = self
            .selected
            .as_ref()
            .and_then(|label| data.activity.buckets.iter().find(|day| day.label == *label));
        if let Some(day) = picked {
            let keys: Vec<String> = day.values.values().flatten().cloned().collect();
            let more = cx.listener(|this, _: &ClickEvent, _, cx| {
                this.limit += MORE;
                cx.notify();
            });
            let id = format!("activity-{}", day.label);
            body = body
                .child(Typo::section_title(format::short_day(&day.label, lang)))
                .child(Typo::caption(self.counts(day, cx)))
                .child(source_list(&id, &keys, self.limit, &self.stats, more, cx));
        }
        Section::new("activity-calendar")
            .title(words.calendar)
            .child(card(body))
    }

    /// The caption, meter and day strip of one focus row.
    fn focus_meta(&self, item: &DashboardStatisticActivity, top: f64, lang: Lang) -> Stack {
        let words = &words(lang).stats;
        let strip = self.stats.data.days.iter().map(|day| {
            ActivityStripDay::new(
                day.date.clone(),
                format::short_day(&day.date, lang),
                item.dates.contains(&day.date),
            )
        });
        let spoken = item
            .dates
            .iter()
            .map(|date| format::short_day(date, lang))
            .collect::<Vec<_>>()
            .join(", ");
        Stack::new()
            .gap(Space::Xs)
            .child(Typo::caption((words.changes)(item.changes)))
            .child(
                ProgressMeter::new(
                    SharedString::from(format!("focus-meter-{}", item.source_key)),
                    pct(count(usize::try_from(item.changes).unwrap_or(0)), top),
                )
                .bare(),
            )
            .child(ActivityStrip::new(
                SharedString::from(format!("focus-strip-{}", item.source_key)),
                strip.collect(),
                spoken,
            ))
    }

    /// One tappable row of the records that changed most.
    fn focus_row(
        &self,
        item: &DashboardStatisticActivity,
        source: &DashboardStatisticSource,
        top: f64,
        cx: &Context<Self>,
    ) -> NavRow {
        let ds = Ds::get(cx);
        let (stats, key) = (self.stats.clone(), item.source_key.clone());
        NavRow::new(SharedString::from(format!("focus-{}", item.source_key)), "")
            .label_element(
                Typo::text(source.title.clone())
                    .line_clamp(2)
                    .wrap(Wrap::Anywhere),
            )
            .multiline()
            .actions(icon(Icon::ChevronRight, IconSize::Md, ds))
            .meta(self.focus_meta(item, top, ds.lang()))
            .on_click(move |_, window, cx| stats.open(&key, window, cx))
    }

    fn focus(&self, cx: &mut Context<Self>) -> Section {
        let lang = Ds::get(cx).lang();
        let all = words(lang);
        let words = &all.stats;
        let data = &self.stats.data;
        let activity = data
            .work
            .as_ref()
            .map_or(&[][..], |work| work.activity.as_slice());
        let mut body = Stack::new().gap(Space::Sm);
        if activity.is_empty() {
            let text = if data.ledger_history_available {
                words.empty
            } else {
                words.unavailable
            };
            body = body.child(Typo::caption(text));
        }
        let top = activity
            .first()
            .map_or(0., |item| count(usize::try_from(item.changes).unwrap_or(0)));
        for item in activity.iter().take(self.focus_limit) {
            let Some(source) = data.sources.get(&item.source_key) else {
                continue;
            };
            body = body.child(self.focus_row(item, source, top, cx));
        }
        if activity.len() > self.focus_limit {
            body = body.child(
                Button::new("focus-more")
                    .variant(Variant::Inline)
                    .text(all.load_more)
                    .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                        this.focus_limit += MORE;
                        cx.notify();
                    })),
            );
        }
        Section::new("activity-focus")
            .title(words.focus)
            .child(card(body))
    }
}

impl Render for ActivityStatistics {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        Grid::new("activity-grid")
            .columns(Columns::Responsive(Responsive {
                compact: None,
                base: Preset::Fixed(1),
                wide: Some(Preset::Fixed(2)),
            }))
            .gap(Space::Xl)
            .page_container()
            .child(self.calendar(cx))
            .child(self.focus(cx))
    }
}
