//! 예약 작업 labels (`app/scheduleLabels.ts`).
use butler_ds::ui::context::Lang;
use chrono::{DateTime, Datelike as _, Local, Timelike as _};

use super::list::copy::words;
use super::types::{AutomationSummary, CalendarSchedule};
use crate::ui::source::wire::CalendarScheduleKind;

/// `scheduleStateLabel`
pub(crate) fn schedule_state(state: &str, lang: Lang) -> &'static str {
    let words = words(lang);
    if state == "enabled" {
        words.on
    } else {
        words.off
    }
}

/// `scheduleWeekday`: 1 is Monday, 7 and 0 Sunday.
#[expect(clippy::cast_possible_truncation, reason = "rem_euclid(7) is 0..=6")]
fn weekday(day: i64, lang: Lang) -> &'static str {
    words(lang).weekday_names[day.rem_euclid(7) as usize]
}

/// `Intl.DateTimeFormat({ hour: "numeric", minute: "2-digit" })`.
fn clock(hour: u32, minute: u32, lang: Lang) -> String {
    let twelve = if hour.is_multiple_of(12) {
        12
    } else {
        hour % 12
    };
    match lang {
        // Chromium separates the day period with U+202F.
        Lang::En => format!(
            "{twelve}:{minute:02}\u{202f}{}",
            if hour < 12 { "AM" } else { "PM" }
        ),
        Lang::Ko => format!(
            "{} {twelve}:{minute:02}",
            if hour < 12 { "오전" } else { "오후" }
        ),
    }
}

/// A schedule rule's `HH:MM` as clock text; the raw text when it does not parse.
fn rule_time(rule: &CalendarSchedule, lang: Lang) -> String {
    let parsed = rule
        .time
        .split_once(':')
        .and_then(|(hour, minute)| Some((hour.parse::<u32>().ok()?, minute.parse::<u32>().ok()?)));
    parsed.map_or_else(
        || rule.time.clone(),
        |(hour, minute)| clock(hour, minute, lang),
    )
}

/// `scheduleFrequencyLabel`
pub(crate) fn schedule_frequency(automation: &AutomationSummary, lang: Lang) -> String {
    let words = words(lang);
    if let Some(rule) = &automation.schedule {
        let time = rule_time(rule, lang);
        if rule.kind == CalendarScheduleKind::Daily {
            return (words.daily_at)(&time);
        }
        if rule.weekdays == [1, 2, 3, 4, 5] {
            return (words.weekdays_at)(&time);
        }
        let days: Vec<&str> = rule.weekdays.iter().map(|d| weekday(*d, lang)).collect();
        return (words.weekly_at)(&days.join(", "), &time);
    }
    if automation.schedule_type.as_deref() == Some("once") {
        return words.once.to_owned();
    }
    let seconds = automation.interval_seconds.unwrap_or(1800);
    if seconds % 3600 == 0 {
        (words.every_hours)(seconds / 3600)
    } else if seconds % 60 == 0 {
        (words.every_minutes)(seconds / 60)
    } else {
        (words.every_seconds)(seconds)
    }
}

/// `scheduleNextRunLabel`
// CARVE-OUT(G-tz): React formats in the schedule's own time zone (`timeZone: schedule.tz`); the
// tree has no time zone database, so the time shows in this computer's zone, which is the zone a
// schedule is created in.
pub(crate) fn schedule_next_run(automation: &AutomationSummary, lang: Lang) -> String {
    let Some(at) = automation
        .next_run_at
        .as_deref()
        .filter(|_| automation.state == "enabled")
        .and_then(|at| DateTime::parse_from_rfc3339(at).ok())
    else {
        return String::new();
    };
    let at = at.with_timezone(&Local);
    let words = words(lang);
    let time = clock(at.hour(), at.minute(), lang);
    let month = (words.month)(at.month());
    let date = match lang {
        Lang::En => format!("{month} {}, {time}", at.day()),
        Lang::Ko => format!("{month} {}일 {time}", at.day()),
    };
    (words.next)(&date)
}
