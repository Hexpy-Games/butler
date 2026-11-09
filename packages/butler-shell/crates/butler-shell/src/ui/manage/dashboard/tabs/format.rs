//! The date and time formats the panels use (`toLocaleDateString`, `toLocaleTimeString` and the
//! short month and weekday of `Intl`), close to the app language's own.
use butler_ds::ui::context::Lang;
use chrono::{DateTime, Datelike as _, Local, NaiveDate, Timelike as _};

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const MONTHS_LONG: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];
const WEEKDAYS_EN: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS_KO: [&str; 7] = ["일", "월", "화", "수", "목", "금", "토"];

/// An RFC 3339 instant in the local zone.
pub(super) fn instant(value: &str) -> Option<DateTime<Local>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|at| at.with_timezone(&Local))
}

/// `toLocaleDateString(locale)`: "2026. 11. 9." / "11/9/2026"; "" when unreadable.
pub(super) fn date(value: &str, lang: Lang) -> String {
    let Some(at) = instant(value) else {
        return String::new();
    };
    match lang {
        Lang::Ko => format!("{}. {}. {}.", at.year(), at.month(), at.day()),
        Lang::En => format!("{}/{}/{}", at.month(), at.day(), at.year()),
    }
}

/// `toLocaleDateString(locale, { year, month: "long", day })`: "2026년 11월 9일" /
/// "November 9, 2026". An unreadable instant is its own text.
pub(super) fn long_date(value: &str, lang: Lang) -> String {
    let Some(at) = instant(value) else {
        return value.to_owned();
    };
    match lang {
        Lang::Ko => format!("{}년 {}월 {}일", at.year(), at.month(), at.day()),
        Lang::En => format!(
            "{} {}, {}",
            MONTHS_LONG[at.month0() as usize % 12],
            at.day(),
            at.year()
        ),
    }
}

/// `toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })`.
pub(super) fn time(value: &str, lang: Lang) -> String {
    let Some(at) = instant(value) else {
        return String::new();
    };
    let (hour, minute) = (at.hour(), at.minute());
    let clock = format!(
        "{}:{minute:02}",
        if hour % 12 == 0 { 12 } else { hour % 12 }
    );
    match lang {
        Lang::Ko => format!("{} {clock}", if hour < 12 { "오전" } else { "오후" }),
        Lang::En => format!("{clock} {}", if hour < 12 { "AM" } else { "PM" }),
    }
}

/// An instant as a short day, in the local zone: "Nov 9" / "11월 9일"; "" when unreadable.
pub(super) fn date_short(value: &str, lang: Lang) -> String {
    let Some(at) = instant(value) else {
        return String::new();
    };
    short_day(&at.format("%Y-%m-%d").to_string(), lang)
}

/// A `YYYY-MM-DD` calendar day.
fn day(label: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(label, "%Y-%m-%d").ok()
}

/// `toLocaleDateString(locale, { month: "short", day: "numeric" })` of a day: "Nov 9" / "11월 9일".
pub(super) fn short_day(label: &str, lang: Lang) -> String {
    let Some(date) = day(label) else {
        return label.to_owned();
    };
    match lang {
        Lang::Ko => format!("{}월 {}일", date.month(), date.day()),
        Lang::En => format!("{} {}", MONTHS[date.month0() as usize % 12], date.day()),
    }
}

/// `toLocaleDateString(locale, { month: "short" })` of a day: "Nov" / "11월".
pub(super) fn month_short(label: &str, lang: Lang) -> String {
    let Some(date) = day(label) else {
        return String::new();
    };
    match lang {
        Lang::Ko => format!("{}월", date.month()),
        Lang::En => MONTHS[date.month0() as usize % 12].to_owned(),
    }
}

/// `new Date(`${label}T12:00:00`).getDay()`: 0 is Sunday.
pub(super) fn weekday(label: &str) -> u8 {
    #[expect(clippy::cast_possible_truncation, reason = "0 to 6")]
    day(label).map_or(0, |date| date.weekday().num_days_from_sunday() as u8)
}

/// The short weekday names, Sunday first.
pub(super) fn weekday_labels(lang: Lang) -> Vec<&'static str> {
    match lang {
        Lang::Ko => WEEKDAYS_KO.to_vec(),
        Lang::En => WEEKDAYS_EN.to_vec(),
    }
}

/// `Intl.NumberFormat(locale, { style: "unit", unit: "second" })` of a duration in milliseconds.
pub(super) fn seconds(milliseconds: f64, lang: Lang) -> String {
    let whole = (milliseconds / 1000.).round();
    match lang {
        Lang::Ko => format!("{whole}초"),
        Lang::En => format!("{whole} sec"),
    }
}
