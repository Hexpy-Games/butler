//! `usage/UsageHistory.tsx`: the lifetime and streak figures.
//!
//! CARVE-OUT(G-heat): React draws an ActivityHeatmap of the days under a daily / weekly /
//! cumulative control; the DS has no heatmap block yet, so only the figures show.
use butler_ds::ui::blocks::metric_card::{GridVariant, MetricCard, MetricGrid, Trend};
use butler_ds::ui::blocks::settings_section::{SettingsSection, SettingsSectionKind};
use butler_ds::ui::context::Lang;
use butler_ds::ui::layout::{Space, Stack};
use gpui::ParentElement as _;

use super::UsagePage;
use super::copy::{Words, words};
use super::format::{duration_minutes, history_date};
use super::wire::{History, Streak};
use crate::ui::composer::context::timeline::usage_tokens;

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

impl UsagePage {
    pub(super) fn history_section(&self, lang: Lang) -> SettingsSection {
        let words = words(lang);
        let grid = match &self.history {
            Some(history) => stats(history, words, lang),
            None => skeleton(words),
        };
        SettingsSection::new(
            "usage-history",
            SettingsSectionKind::Status,
            words.history_title,
        )
        .child(Stack::new().gap(Space::Lg).child(grid))
    }
}
