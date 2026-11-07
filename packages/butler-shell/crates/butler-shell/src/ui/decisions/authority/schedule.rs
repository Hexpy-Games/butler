//! `scheduleTiming` (`app/scheduleLabels.ts`): when a schedule a request would create runs.
use butler_ds::ui::context::Lang;
use chrono::{DateTime, Datelike as _, Local, Timelike as _};

use super::request::Schedule;
use crate::ui::i18n::authority::Authority;

/// A 12-hour clock (`hour12`) for a `HH:MM` time of the schedule's rule.
fn clock(time: &str, lang: Lang) -> String {
    let parsed = time.split_once(':').and_then(|(h, m)| {
        Some((
            h.parse::<u32>().ok().filter(|h| *h < 24)?,
            m.parse::<u32>().ok().filter(|m| *m < 60)?,
        ))
    });
    let Some((hour, minute)) = parsed else {
        return time.to_owned();
    };
    twelve(hour, minute, lang)
}

fn twelve(hour: u32, minute: u32, lang: Lang) -> String {
    let h = if hour.is_multiple_of(12) {
        12
    } else {
        hour % 12
    };
    match lang {
        Lang::En => format!("{h}:{minute:02} {}", if hour < 12 { "AM" } else { "PM" }),
        Lang::Ko => format!(
            "{} {h}:{minute:02}",
            if hour < 12 { "오전" } else { "오후" }
        ),
    }
}

/// The first run, as a short local date and time (month, day, time).
fn moment(at: &str, lang: Lang) -> Option<String> {
    let local = DateTime::parse_from_rfc3339(at).ok()?.with_timezone(&Local);
    let time = twelve(local.hour(), local.minute(), lang);
    Some(match lang {
        Lang::En => {
            const MONTHS: [&str; 12] = [
                "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
            ];
            format!(
                "{} {}, {time}",
                MONTHS[local.month0() as usize],
                local.day()
            )
        }
        Lang::Ko => format!("{}월 {}일 {time}", local.month(), local.day()),
    })
}

/// A schedule request's frequency, then its first run time.
pub(super) fn timing(schedule: &Schedule, copy: Authority) -> String {
    let lang = copy.lang();
    let kind = schedule.kind.as_str();
    if let (true, Some(time)) = (
        matches!(kind, "daily" | "weekdays"),
        schedule.time.as_deref(),
    ) {
        let time = clock(time, lang);
        return if kind == "daily" {
            copy.daily_at(&time)
        } else {
            copy.weekdays_at(&time)
        };
    }
    let once = kind == "once";
    let frequency = if once {
        copy.once().to_owned()
    } else {
        copy.every(schedule.interval_seconds.unwrap_or(1800))
    };
    let at = if once {
        schedule.run_at.as_deref()
    } else {
        schedule.start_at.as_deref()
    };
    match at.and_then(|at| moment(at, lang)) {
        Some(time) if once => format!("{frequency} · {time}"),
        Some(time) => format!("{frequency} · {}", copy.next(&time)),
        None => frequency,
    }
}
