//! A visit's day heading and clock (`toLocaleDateString` / `toLocaleTimeString`).
use butler_ds::ui::context::Lang;
use chrono::{DateTime, Datelike as _, Local, TimeZone as _, Timelike as _};

use super::copy::Words;

fn local(millis: i64) -> Option<DateTime<Local>> {
    Local.timestamp_millis_opt(millis).single()
}

/// The heading of a day: "Monday, November 9, 2026" / "2026년 11월 9일 월요일".
pub(super) fn day(millis: i64, lang: Lang, words: &Words) -> String {
    let Some(date) = local(millis) else {
        return String::new();
    };
    let weekday = words.weekdays[date.weekday().num_days_from_sunday() as usize];
    let month = words.months[date.month0() as usize];
    match lang {
        Lang::Ko => format!("{}년 {month} {}일 {weekday}", date.year(), date.day()),
        Lang::En => format!("{weekday}, {month} {}, {}", date.day(), date.year()),
    }
}

/// The clock of a visit: "3:05 PM" / "오후 3:05".
pub(super) fn time(millis: i64, lang: Lang) -> String {
    let Some(date) = local(millis) else {
        return String::new();
    };
    let (pm, hour) = date.hour12();
    let minute = date.minute();
    match lang {
        Lang::Ko => format!("{} {hour}:{minute:02}", if pm { "오후" } else { "오전" }),
        Lang::En => format!("{hour}:{minute:02} {}", if pm { "PM" } else { "AM" }),
    }
}
