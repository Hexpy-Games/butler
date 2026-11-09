//! `usage/UsageHistory.tsx`: the lifetime and streak figures, and the heatmap of the days under a
//! daily / weekly / cumulative control (`usageHistoryModel.ts` is `history/model.rs`).
mod model;

use butler_ds::ui::blocks::activity_heatmap::{
    ActivityHeatmap, ActivityHeatmapDay, HeatmapCell, ScrollAnchor,
};
use butler_ds::ui::blocks::metric_card::{GridVariant, MetricCard, MetricGrid, Trend};
use butler_ds::ui::blocks::settings_section::{SettingsSection, SettingsSectionKind};
use butler_ds::ui::context::Lang;
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::segmented_control::{Choice, SegmentedControl};
use chrono::{Datelike as _, NaiveDate};
use gpui::{App, Context, ParentElement as _, SharedString, Window, div};

use self::model::{Mode, Window as Span, window};

use super::UsagePage;
use super::copy::{Words, words};
use super::format::{duration_minutes, history_date};
use super::wire::{History, Streak};
use crate::ui::composer::context::timeline::usage_tokens;
use crate::ui::widgets::anchor;

/// `localeWeekStart`: the app's two languages both start the week on Sunday.
const WEEK_START: u32 = 0;

/// The caption line a card reserves when it has nothing to say.
const BLANK: &str = " ";

fn streak_range(streak: &Streak, lang: Lang) -> String {
    match (&streak.start, &streak.end) {
        (Some(start), Some(end)) => {
            format!(
                "{} – {}",
                history_date(start, lang),
                history_date(end, lang)
            )
        }
        _ => BLANK.to_owned(),
    }
}

/// `HistoryStats`
fn stats(history: &History, words: &'static Words, lang: Lang) -> MetricGrid {
    let tokens = move |value: f64| usage_tokens(value, lang);
    #[expect(clippy::cast_possible_truncation, reason = "a whole number of days")]
    let days = move |value: f64| (words.days)(value.round() as i64);
    let busiest = match &history.busiest_day {
        Some(day) => MetricCard::number("usage-busiest", day.tokens, words.busiest_day)
            .format(tokens)
            .change(history_date(&day.date, lang)),
        None => MetricCard::text("usage-busiest", "—", words.busiest_day).change(BLANK),
    };
    let longest = match &history.longest_task {
        Some(task) => MetricCard::number(
            "usage-longest-task",
            task.duration_ms / 60_000.,
            words.longest_task,
        )
        .format(move |minutes| duration_minutes(minutes, words))
        .change(task.title.clone().unwrap_or_else(|| BLANK.to_owned())),
        None => MetricCard::text("usage-longest-task", "—", words.longest_task).change(BLANK),
    };
    MetricGrid::new("usage-history-stats")
        .variant(GridVariant::Joined)
        .child(
            MetricCard::number(
                "usage-lifetime",
                history.lifetime_tokens,
                words.lifetime_tokens,
            )
            .format(tokens)
            .change(BLANK),
        )
        .child(busiest.trend(Trend::Neutral))
        .child(longest.trend(Trend::Neutral))
        .child(
            MetricCard::number(
                "usage-longest-streak",
                history.longest_streak.days,
                words.longest_streak,
            )
            .format(days)
            .change(streak_range(&history.longest_streak, lang))
            .trend(Trend::Neutral),
        )
        .child(
            MetricCard::number(
                "usage-current-streak",
                history.current_streak.days,
                words.current_streak,
            )
            .format(days)
            .change(BLANK),
        )
}

/// `HistorySkeleton`: dashes, with the caption line reserved so wrapped rows keep their height.
fn skeleton(words: &Words) -> MetricGrid {
    [
        words.lifetime_tokens,
        words.busiest_day,
        words.longest_task,
        words.longest_streak,
        words.current_streak,
    ]
    .into_iter()
    .enumerate()
    .fold(
        MetricGrid::new("usage-history-skeleton").variant(GridVariant::Joined),
        |grid, (index, label)| {
            grid.child(MetricCard::text(("usage-history-loading", index), "—", label).change(BLANK))
        },
    )
}

/// The month name over a week: `Intl` `{ month: "short" }`.
fn month_label(date: NaiveDate, lang: Lang) -> String {
    match lang {
        Lang::En => date.format("%b").to_string(),
        Lang::Ko => format!("{}월", date.month()),
    }
}

/// The shown value, level and tooltip of one day under `mode`.
fn heat_day(
    span: &Span,
    (index, today): (usize, &str),
    (mode, lang): (Mode, Lang),
    words: &Words,
) -> Option<ActivityHeatmapDay> {
    let date = span.dates.get(index)?;
    if mode == Mode::Daily && date.as_str() > today {
        return None;
    }
    let (week, row) = (index / 7, index % 7);
    let weekly = history_date(&span.dates[week * 7], lang);
    let value = match mode {
        Mode::Daily => span.values[index],
        Mode::Weekly => span.weeks[week],
        Mode::Cumulative => span.cumulative[week],
    };
    let height = match mode {
        Mode::Weekly => span.weekly_heights[week],
        _ => span.cumulative_heights[week],
    };
    let label = match mode {
        Mode::Daily => history_date(date, lang),
        Mode::Weekly => (words.week_of)(&weekly),
        Mode::Cumulative => (words.through_week)(&weekly),
    };
    let level = match mode {
        Mode::Daily => span.levels[index],
        _ if row + height >= 7 => 3,
        _ => 0,
    };
    let month = NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map_or_else(|_| String::new(), |d| month_label(d, lang));
    let words_of = if value > 0. {
        usage_tokens(value, lang)
    } else {
        words.no_usage.to_owned()
    };
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a token count"
    )]
    let count = value as u64;
    Some(
        ActivityHeatmapDay::new(date.clone(), label, Some(count))
            .month_label(month)
            .count_label(words_of)
            .level(level),
    )
}

/// `heatmapDays`; while the history loads every day is empty.
fn heat_days(
    history: Option<&History>,
    mode: Mode,
    lang: Lang,
    words: &Words,
) -> Vec<ActivityHeatmapDay> {
    let days = history.map(|h| h.days.as_slice()).unwrap_or_default();
    let today = days.last().map_or_else(
        || chrono::Local::now().format("%Y-%m-%d").to_string(),
        |(date, _)| date.clone(),
    );
    let end = NaiveDate::parse_from_str(&today, "%Y-%m-%d")
        .unwrap_or_else(|_| chrono::Local::now().date_naive());
    let span = window(days, history.map_or(0., |h| h.prior_total), WEEK_START, end);
    (0..span.dates.len())
        .filter_map(|index| heat_day(&span, (index, &today), (mode, lang), words))
        .map(|day| match history {
            Some(_) => day,
            None => ActivityHeatmapDay {
                count: Some(0),
                count_label: Some(SharedString::default()),
                level: Some(0),
                ..day
            },
        })
        .collect()
}

impl UsagePage {
    /// `UsageHistory`
    pub(super) fn history_section(
        &self,
        lang: Lang,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> SettingsSection {
        let words = words(lang);
        let grid = match &self.history {
            Some(history) => stats(history, words, lang),
            None => skeleton(words),
        };
        let mode = window.use_keyed_state("usage-history-mode", cx, |_, _| {
            SharedString::from(Mode::Daily.key())
        });
        let write = mode.clone();
        let mode = Mode::of(mode.read(cx));
        let control = SegmentedControl::new("usage-history-view", words.history_title, mode.key())
            .options([
                Choice::new(Mode::Daily.key(), words.view_daily),
                Choice::new(Mode::Weekly.key(), words.view_weekly),
                Choice::new(Mode::Cumulative.key(), words.view_cumulative),
            ])
            .on_value_change(move |value: &str, _: &mut Window, cx: &mut App| {
                write.update(cx, |mode, cx| {
                    *mode = SharedString::from(Mode::of(value).key());
                    cx.notify();
                });
            });
        let labels = (0..7)
            .map(|row| {
                if row % 2 == 0 {
                    SharedString::default()
                } else {
                    words.weekdays[(WEEK_START as usize + row) % 7].into()
                }
            })
            .collect();
        let heatmap = ActivityHeatmap::new(
            "usage-history-heatmap",
            heat_days(self.history.as_ref(), mode, lang, words),
        )
        .aria_label(words.history_title)
        .cell(HeatmapCell::Compact)
        .scroll_anchor(ScrollAnchor::End)
        .start_weekday(0)
        .weekday_labels(labels);
        let body = Stack::new()
            .gap(Space::Lg)
            .child(grid)
            .child(control)
            .child(heatmap);
        SettingsSection::new(
            "usage-history",
            SettingsSectionKind::Status,
            words.history_title,
        )
        .child(anchor(div(), "usage-history").child(body))
    }
}
