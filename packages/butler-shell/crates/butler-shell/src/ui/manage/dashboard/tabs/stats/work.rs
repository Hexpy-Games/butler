//! `management/ProjectWorkStatistics.tsx`: how work changed, where it remains, and what to
//! revisit.
use std::rc::Rc;

use butler_ds::ui::Icon;
use butler_ds::ui::blocks::nav_row::NavRow;
use butler_ds::ui::blocks::progress_meter::ProgressMeter;
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{
    Border, Box as Frame, Columns, Grid, Preset, Radius, Responsive, Space, Stack,
};
use butler_ds::ui::section::Section;
use butler_ds::ui::segmented_control::{Choice, SegmentedControl, Size};
use butler_ds::ui::typo::{Typo, Wrap};
use gpui::{
    AnyElement, AppContext as _, ClickEvent, Context, Entity, IntoElement, ParentElement as _,
    Render, SharedString, Window,
};

use super::chart::{Heading, StatChart};
use super::sources::{FIRST, MORE, source_list};
use super::{Stats, count, pct};
use crate::ui::manage::dashboard::tabs::copy::words;
use crate::ui::source::wire::DashboardStatisticCard;

const LANES: [&str; 4] = ["planned", "active", "review", "blocked"];

/// `ProjectWorkStatistics`
pub(super) struct WorkStatistics {
    stats: Rc<Stats>,
    /// "work" or "task"
    kind: &'static str,
    lane: Option<&'static str>,
    limit: usize,
    chart: Entity<StatChart>,
}

/// The flow chart of one kind (React keys it by `kind`, so a switch starts it fresh).
fn flow(stats: &Rc<Stats>, kind: &str, cx: &mut Context<WorkStatistics>) -> Entity<StatChart> {
    let (heading, series) = match (&stats.data.work, kind) {
        (Some(work), "task") => (Heading::TaskFlow, Some(work.task.clone())),
        (Some(work), _) => (Heading::Flow, Some(work.work.clone())),
        (None, _) => (Heading::Flow, None),
    };
    let variants = series
        .map(|series| (kind_name(kind), series))
        .into_iter()
        .collect();
    cx.new(|_| StatChart::new("work-flow", heading, variants, false, stats.clone()))
}

fn kind_name(kind: &str) -> &'static str {
    if kind == "task" { "task" } else { "work" }
}

impl WorkStatistics {
    pub(super) fn new(stats: Rc<Stats>, cx: &mut Context<Self>) -> Self {
        let chart = flow(&stats, "work", cx);
        Self {
            stats,
            kind: "work",
            lane: None,
            limit: FIRST,
            chart,
        }
    }

    fn set_kind(&mut self, value: &str, cx: &mut Context<Self>) {
        self.kind = kind_name(value);
        self.lane = None;
        self.limit = FIRST;
        self.chart = flow(&self.stats, self.kind, cx);
        cx.notify();
    }

    fn set_lane(&mut self, lane: &'static str, cx: &mut Context<Self>) {
        self.lane = Some(lane);
        self.limit = FIRST;
        cx.notify();
    }

    /// The four stages with their counts, and the records of the chosen one.
    fn remaining(&self, cards: &[DashboardStatisticCard], cx: &mut Context<Self>) -> Section {
        let all = words(Ds::get(cx).lang());
        let words = &all.stats;
        let counts: Vec<usize> = LANES
            .iter()
            .map(|stage| cards.iter().filter(|card| card.card.lane == *stage).count())
            .collect();
        let maximum = count(counts.iter().copied().max().unwrap_or(0));
        let mut stack = Stack::new().gap(Space::Sm);
        for (stage, total) in LANES.iter().zip(&counts) {
            let label = words.label_or(stage);
            let meter = ProgressMeter::new(
                SharedString::from(format!("work-lane-meter-{stage}")),
                pct(count(*total), maximum),
            )
            .label(label)
            .meta(total.to_string());
            let stage = *stage;
            let chevron = icon(Icon::ChevronRight, IconSize::Md, Ds::get(cx));
            stack = stack.child(
                NavRow::new(SharedString::from(format!("work-lane-{stage}")), "")
                    .label_element(meter)
                    .actions(chevron)
                    .on_click(
                        cx.listener(move |this, _: &ClickEvent, _, cx| this.set_lane(stage, cx)),
                    ),
            );
        }
        let unknown = cards
            .iter()
            .filter(|card| card.card.lane == "other")
            .count();
        if unknown > 0 {
            stack = stack.child(Typo::caption(format!(
                "{} · {unknown}",
                words.label_or("other")
            )));
        }
        if let Some(lane) = self.lane {
            let keys: Vec<String> = cards
                .iter()
                .filter(|card| card.card.lane == lane)
                .map(|card| card.source_key.clone())
                .collect();
            let more = cx.listener(|this, _: &ClickEvent, _, cx| {
                this.limit += MORE;
                cx.notify();
            });
            let id = format!("work-sources-{}-{lane}", self.kind);
            stack = stack.child(source_list(&id, &keys, self.limit, &self.stats, more, cx));
        }
        Section::new("work-remaining")
            .title(words.remaining)
            .description(words.remaining_help)
            .child(
                Frame::new()
                    .border(Border::Hairline)
                    .radius(Radius::Control)
                    .padding_x(Space::Lg)
                    .padding_y(Space::Md)
                    .child(stack),
            )
    }

    /// The oldest remaining records, blocked ones first.
    fn aging(&self, cards: &[DashboardStatisticCard], cx: &Context<Self>) -> Section {
        let all = words(Ds::get(cx).lang());
        let words = &all.stats;
        let ds = Ds::get(cx);
        let mut old: Vec<&DashboardStatisticCard> = cards
            .iter()
            .filter(|card| LANES.contains(&card.card.lane.as_str()))
            .collect();
        old.sort_by(|a, b| {
            (b.card.lane == "blocked")
                .cmp(&(a.card.lane == "blocked"))
                .then(
                    b.age_days
                        .unwrap_or(-1.)
                        .total_cmp(&a.age_days.unwrap_or(-1.)),
                )
        });
        old.truncate(5);
        let oldest = old
            .iter()
            .filter_map(|card| card.age_days)
            .fold(0., f64::max);
        let mut grid = Grid::new("work-aging-grid")
            .columns(Columns::AUTO_FIT)
            .gap(Space::Md);
        if old.is_empty() {
            grid = grid.child(Typo::caption(all.no_remaining));
        }
        for card in old {
            let stage = words.label_or(&card.card.lane);
            let age = card.age_days.map(|age| {
                #[expect(clippy::cast_possible_truncation, reason = "whole days")]
                let days = age.round() as i64;
                (words.age)(days)
            });
            let mut meta = Stack::new().gap(Space::Xs).child(Typo::caption(format!(
                "{stage} · {}",
                age.clone().unwrap_or_else(|| words.label_or("unknown"))
            )));
            if let Some(age_days) = card.age_days {
                meta = meta.child(
                    ProgressMeter::new(
                        SharedString::from(format!("work-age-{}", card.card.id)),
                        pct(age_days, oldest),
                    )
                    .bare(),
                );
            }
            let (stats, key) = (self.stats.clone(), card.source_key.clone());
            grid = grid.child(
                Frame::new()
                    .border(Border::Hairline)
                    .radius(Radius::Control)
                    .padding(Space::Md)
                    .child(
                        NavRow::new(SharedString::from(format!("work-old-{}", card.card.id)), "")
                            .label_element(
                                Typo::text(card.card.title.clone())
                                    .line_clamp(2)
                                    .wrap(Wrap::Anywhere),
                            )
                            .multiline()
                            .actions(icon(Icon::ChevronRight, IconSize::Md, ds))
                            .meta(meta)
                            .on_click(move |_, window, cx| stats.open(&key, window, cx)),
                    ),
            );
        }
        Section::new("work-aging")
            .title(words.aging)
            .description(words.aging_help)
            .child(grid)
    }
}

impl Render for WorkStatistics {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let all = words(Ds::get(cx).lang());
        let words = &all.stats;
        let stats = self.stats.clone();
        let Some(work) = &stats.data.work else {
            return Section::new("work-flow")
                .title(words.flow)
                .child(Typo::caption(words.unavailable))
                .into_any_element();
        };
        let cards = work.cards.get(self.kind).map_or(&[][..], Vec::as_slice);
        let mut flow = Stack::new().gap(Space::Sm);
        flow = if stats.data.ledger_history_available {
            flow.child(self.chart.clone())
        } else {
            flow.child(
                Section::new("work-flow")
                    .title(words.flow)
                    .child(Typo::caption(words.history_unavailable)),
            )
        };
        if work.excluded > 0 {
            flow = flow.child(Typo::caption((words.excluded)(work.excluded)));
        }
        let top = Grid::new("work-flow-grid")
            .columns(Columns::Responsive(Responsive {
                compact: None,
                base: Preset::Fixed(1),
                wide: Some(Preset::MainAside),
            }))
            .gap(Space::Xl)
            .page_container()
            .child(flow)
            .child(self.remaining(cards, cx));
        let controls = SegmentedControl::new("work-kind", all.statistics_kind, self.kind)
            .size(Size::Sm)
            .options([
                Choice::new("work", all.work()),
                Choice::new("task", all.task()),
            ])
            .on_value_change(cx.listener(|this, value: &str, _, cx| this.set_kind(value, cx)));
        let section: AnyElement = Section::new("work-statistics")
            .title_element(Typo::panel_title(words.work_overview))
            .actions(controls)
            .gap(Space::Xl)
            .child(top)
            .child(self.aging(cards, cx))
            .into_any_element();
        section
    }
}
