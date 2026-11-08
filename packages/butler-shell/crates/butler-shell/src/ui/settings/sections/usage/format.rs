//! The page's text formats: `usageHistoryModel.ts` (`historyDate`, `durationMinutes`), the number
//! and time formats of `Intl`, and `usageProviderName`.
use butler_ds::ui::animated_number::grouped;
use butler_ds::ui::blocks::usage_bars::{civil_from_days, day_and_hour};
use butler_ds::ui::context::Lang;

use super::copy::Words;
use crate::ui::composer::context::usage::{clock, local_offset_ms, parse_ms, usage_time};

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// `new Intl.NumberFormat(locale).format(value)` for a count.
pub(super) fn count(value: f64) -> String {
    grouped(value.round())
}

/// `durationMinutes`: "1h 5m" / "1시간 5분".
pub(super) fn duration_minutes(total_minutes: f64, words: &Words) -> String {
    #[expect(clippy::cast_possible_truncation, reason = "whole minutes")]
    let minutes = total_minutes.max(0.).floor() as i64;
    let (hours, rest) = (minutes / 60, minutes % 60);
    let mut parts = Vec::new();
    if hours > 0 {
        parts.push((words.duration_hours)(hours));
    }
    if rest > 0 || hours == 0 {
        parts.push((words.elapsed_minutes)(rest));
    }
    parts.join(" ")
}

/// `historyDate`: a `YYYY-MM-DD` calendar date as "Oct 2" / "10월 2일".
pub(super) fn history_date(key: &str, lang: Lang) -> String {
    let mut parts = key
        .split('-')
        .skip(1)
        .map(|part| part.parse::<usize>().ok());
    let (Some(Some(month)), Some(Some(day))) = (parts.next(), parts.next()) else {
        return key.to_owned();
    };
    match lang {
        Lang::En => format!("{} {day}", MONTHS[month.saturating_sub(1) % 12]),
        Lang::Ko => format!("{month}월 {day}일"),
    }
}

/// `Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" })` of an instant.
pub(super) fn date_time(at_ms: i64, lang: Lang) -> String {
    let wall = at_ms + local_offset_ms();
    let (year, month, day) = civil_from_days(day_and_hour(wall).0);
    let minutes = wall.rem_euclid(86_400_000) / 60_000;
    let (hour, minute) = (minutes / 60, minutes % 60);
    let hour12 = if hour % 12 == 0 { 12 } else { hour % 12 };
    match lang {
        Lang::En => format!(
            "{} {day}, {year}, {hour12}:{minute:02} {}",
            MONTHS[usize::try_from(month - 1).unwrap_or(0) % 12],
            if hour < 12 { "AM" } else { "PM" }
        ),
        Lang::Ko => format!(
            "{year}. {month}. {day}. {} {hour12}:{minute:02}",
            if hour < 12 { "오전" } else { "오후" }
        ),
    }
}

/// `usageClock(Date.parse(value))`: "14:05", or "—" when the date is unreadable.
pub(super) fn clock_of(value: &str) -> String {
    parse_ms(value).map_or_else(|| "—".to_owned(), |at| clock(at + local_offset_ms()))
}

/// `usageTime(new Date(ms).toISOString())`
pub(super) fn time_of_ms(at_ms: f64, now: i64, lang: Lang) -> String {
    #[expect(clippy::cast_possible_truncation, reason = "epoch milliseconds")]
    let iso = chrono::DateTime::from_timestamp_millis(at_ms as i64)
        .map(|at| at.to_rfc3339())
        .unwrap_or_default();
    usage_time(&iso, now, lang)
}

/// `usageProviderName`: "open-ai" as "Open Ai".
pub(super) fn provider_name(id: &str) -> String {
    id.split(|c: char| c == '-' || c == '_' || c.is_whitespace())
        .filter(|word| !word.is_empty())
        .map(|word| {
            let mut chars = word.chars();
            chars.next().map_or_else(String::new, |first| {
                first.to_uppercase().chain(chars).collect()
            })
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// A percentage for a ProgressMeter.
pub(super) fn meter_value(percent: f64) -> f32 {
    #[expect(
        clippy::cast_possible_truncation,
        reason = "a percentage between 0 and 100"
    )]
    let value = percent.clamp(0., 100.) as f32;
    value
}
