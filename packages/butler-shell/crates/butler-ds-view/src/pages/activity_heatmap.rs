//! ActivityHeatmap.showcase.tsx: the Usage page's year of compact cells (Daily and Weekly), the
//! project statistics' 90 selectable days with a legend, and the read-only recent activity.
#![expect(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "sample data of a few hundred days"
)]
use butler_ds::ui::blocks::activity_heatmap::{
    ActivityHeatmap, ActivityHeatmapDay, HeatmapCell, ScrollAnchor,
};
use butler_ds::ui::blocks::usage_bars::civil_from_days;
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::segmented_control::{Choice, SegmentedControl};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, SharedString, Window};

use super::Story;
use crate::copy::Lang;

/// 2026-06-29 (a Monday) and 2025-10-19 (a Sunday), in days since 1970-01-01.
const START: i64 = 20_633;
const YEAR_START: i64 = 20_380;
const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const WEEKDAYS: ([&str; 7], [&str; 7]) = (
    ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    ["일", "월", "화", "수", "목", "금", "토"],
);

struct Copy {
    calendar: &'static str,
    recent: &'static str,
    legend: &'static str,
    unavailable: &'static str,
    year: &'static str,
    none: &'static str,
    daily: &'static str,
    weekly: &'static str,
    view: &'static str,
    items: fn(u64) -> String,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            calendar: "Activity calendar",
            recent: "Recent activity",
            legend: "Active items per day",
            unavailable: "Unavailable",
            year: "Usage over the past year",
            none: "No usage",
            daily: "Daily",
            weekly: "Weekly",
            view: "View",
            items: |count| format!("{count} active items"),
        },
        Copy {
            calendar: "활동 달력",
            recent: "최근 활동",
            legend: "하루 활동 항목",
            unavailable: "사용할 수 없음",
            year: "지난 1년 사용량",
            none: "사용 없음",
            daily: "일별",
            weekly: "주별",
            view: "보기",
            items: |count| format!("활동 항목 {count}개"),
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Usage year (compact, levels, wave)",
            render: usage_year,
        },
        Story {
            name: "Project statistics (selectable)",
            render: statistics,
        },
        Story {
            name: "Recent activity (read-only)",
            render: recent,
        },
    ]
}

/// `(month, day)` of `epoch_day`, as the labels `toLocaleDateString` gives.
fn date(epoch_day: i64, lang: Lang) -> (String, String) {
    let (_, month, day) = civil_from_days(epoch_day);
    let name = MONTHS[usize::try_from(month - 1).unwrap_or(0) % 12];
    lang.pick(
        (name.to_owned(), format!("{name} {day}")),
        (format!("{month}월"), format!("{month}월 {day}일")),
    )
}

fn weekday(row: usize, lang: Lang) -> SharedString {
    lang.pick(WEEKDAYS.0, WEEKDAYS.1)[row % 7].into()
}

/// 35 or 90 days from June 29, one of them unavailable on request.
fn days(lang: Lang, length: usize, with_unavailable: bool) -> Vec<ActivityHeatmapDay> {
    let c = copy(lang);
    (0..length)
        .map(|index| {
            let count = (!(with_unavailable && index == 3)).then_some((index as u64 * 7) % 18);
            #[expect(
                clippy::cast_possible_wrap,
                reason = "index < length, a few hundred days"
            )]
            let (month, label) = date(START + index as i64, lang);
            let words = count.map_or_else(|| c.unavailable.to_owned(), c.items);
            ActivityHeatmapDay::new(format!("day-{index}"), label, count)
                .month_label(month)
                .count_label(words)
        })
        .collect()
}

fn weekdays(lang: Lang) -> Vec<SharedString> {
    (0..7).map(|row| weekday(row, lang)).collect()
}

fn statistics(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let selected = window.use_keyed_state("heatmap-selected", cx, |_, _| None::<SharedString>);
    let write = selected.clone();
    let mut heatmap = ActivityHeatmap::new("heatmap-statistics", days(lang, 90, true))
        .aria_label(c.calendar)
        .start_weekday(1)
        .weekday_labels(weekdays(lang))
        .legend(
            c.legend,
            ["0", "1", "2–4", "5–9", "10+", c.unavailable]
                .map(Into::into)
                .to_vec(),
        )
        .on_select(move |id, _, cx| {
            write.update(cx, |selected, cx| {
                *selected = Some(id.to_owned().into());
                cx.notify();
            });
        });
    if let Some(id) = selected.read(cx).clone() {
        heatmap = heatmap.selected_id(id);
    }
    heatmap.into_any_element()
}

fn recent(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    ActivityHeatmap::new("heatmap-recent", days(lang, 35, false))
        .aria_label(copy(lang).recent)
        .start_weekday(1)
        .into_any_element()
}

/// A deterministic, heavy-tailed year of usage: idle weekends, a few huge days.
fn year_tokens(index: u64) -> f64 {
    if index.is_multiple_of(7) || (index * 13).is_multiple_of(11) {
        return 0.;
    }
    let boost = if index.is_multiple_of(37) { 8. } else { 1. };
    ((index * 7919) % 97) as f64 * 1_000_000. * boost
}

/// 53 full weeks of compact cells; Weekly fills columns bottom-up.
fn year_days(lang: Lang, weekly: bool) -> Vec<ActivityHeatmapDay> {
    let c = copy(lang);
    let tokens: Vec<f64> = (0..371).map(year_tokens).collect();
    let max = tokens.iter().copied().fold(0., f64::max);
    let totals: Vec<f64> = tokens.chunks(7).map(|week| week.iter().sum()).collect();
    let max_week = totals.iter().copied().fold(0., f64::max);
    tokens
        .iter()
        .enumerate()
        .map(|(index, &count)| {
            let filled = (7. * totals[index / 7] / max_week).ceil();
            let level = if weekly {
                u8::from(6 - (index % 7) < filled as usize) * 3
            } else if count == 0. {
                0
            } else {
                (4. * count / max).ceil().min(4.) as u8
            };
            #[expect(clippy::cast_possible_wrap, reason = "index < 366, days of one year")]
            let (month, label) = date(YEAR_START + index as i64, lang);
            let words = if count == 0. {
                c.none.to_owned()
            } else {
                format!("{}M", (count / 1_000_000.).round())
            };
            ActivityHeatmapDay::new(format!("year-{index}"), label, Some(count as u64))
                .month_label(month)
                .count_label(words)
                .level(level)
        })
        .collect()
}

fn usage_year(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let view = window.use_keyed_state("heatmap-view", cx, |_, _| SharedString::from("daily"));
    let write = view.clone();
    let value = view.read(cx).clone();
    let labels = (0..7)
        .map(|row| {
            if row % 2 == 1 {
                weekday(row, lang)
            } else {
                SharedString::default()
            }
        })
        .collect();
    Stack::new()
        .gap(Space::Md)
        .child(
            SegmentedControl::new("heatmap-view-control", c.view, value.clone())
                .options([
                    Choice::new("daily", c.daily),
                    Choice::new("weekly", c.weekly),
                ])
                .on_value_change(move |next, _, cx| {
                    write.update(cx, |view, cx| {
                        *view = next.to_owned().into();
                        cx.notify();
                    });
                }),
        )
        .child(
            ActivityHeatmap::new("heatmap-year", year_days(lang, value == "weekly"))
                .aria_label(c.year)
                .cell(HeatmapCell::Compact)
                .scroll_anchor(ScrollAnchor::End)
                .start_weekday(0)
                .weekday_labels(labels),
        )
        .into_any_element()
}
