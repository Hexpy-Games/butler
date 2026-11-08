//! The two date formats of the page: `Intl.DateTimeFormat(locale, { month: "short", day:
//! "numeric" })` for an approval, `{ dateStyle: "short" }` for an account.
use butler_ds::ui::context::Lang;
use chrono::{DateTime, Datelike as _, Local, Utc};

/// "Nov 8" / "11월 8일"; empty when the date does not parse.
pub(super) fn month_day(rfc3339: &str, lang: Lang) -> String {
    let Ok(date) = DateTime::parse_from_rfc3339(rfc3339) else {
        return String::new();
    };
    let date = date.with_timezone(&Local);
    match lang {
        Lang::Ko => format!("{}월 {}일", date.month(), date.day()),
        Lang::En => date.format("%b %-d").to_string(),
    }
}

/// "11/8/26" / "26. 11. 8." for Unix seconds.
pub(super) fn short(seconds: i64, lang: Lang) -> String {
    let Some(date) = DateTime::<Utc>::from_timestamp(seconds, 0) else {
        return String::new();
    };
    let date = date.with_timezone(&Local);
    match lang {
        Lang::Ko => date.format("%y. %-m. %-d.").to_string(),
        Lang::En => date.format("%-m/%-d/%y").to_string(),
    }
}
