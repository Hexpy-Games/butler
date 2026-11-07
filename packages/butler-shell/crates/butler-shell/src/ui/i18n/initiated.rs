//! The copy of the canon and initiated-work decision panels. Each field names its
//! `packages/butler-i18n` key.
use butler_ds::ui::context::{Ds, Lang};
use gpui::App;

pub(crate) struct Initiated {
    /// canon.queue: removed, continued, resolved, taken
    pub(crate) removed: &'static str,
    pub(crate) continued: &'static str,
    pub(crate) resolved: &'static str,
    pub(crate) taken: &'static str,
    /// canon.queue: remove, proceed, openOther, take
    pub(crate) remove: &'static str,
    pub(crate) proceed: &'static str,
    pub(crate) open_other: &'static str,
    pub(crate) take: &'static str,
    /// canon.deletion.deleted
    pub(crate) epic_deleted: &'static str,
    /// conversation.initiated: noThanks, soundsGood, needsApproval, alreadyHandled, failed
    pub(crate) no_thanks: &'static str,
    pub(crate) sounds_good: &'static str,
    pub(crate) needs_approval: &'static str,
    pub(crate) already_handled: &'static str,
    pub(crate) failed: &'static str,
    /// conversation.initiated: created, skipped, continuing, paused
    pub(crate) created: fn(&str) -> String,
    pub(crate) skipped: fn(&str) -> String,
    pub(crate) continuing: fn(&str) -> String,
    pub(crate) paused: fn(&str) -> String,
    /// conversation.initiated: dailyAt, weekdaysAt, unopened, action (without the start date)
    pub(crate) daily_at: fn(&str) -> String,
    pub(crate) weekdays_at: fn(&str) -> String,
    pub(crate) unopened: fn(i64) -> String,
    pub(crate) action: fn(&str, &str) -> String,
    /// automations: weeklyAt, interval, once
    pub(crate) weekly_at: fn(&str, &str) -> String,
    pub(crate) interval: &'static str,
    pub(crate) once: &'static str,
    /// settings.memory: patternDays, patternWeeks, patternMonths, patternCount
    pub(crate) pattern_days: fn(i64) -> String,
    pub(crate) pattern_weeks: fn(i64) -> String,
    pub(crate) pattern_months: fn(i64) -> String,
    pub(crate) pattern_count: fn(i64) -> String,
    /// A clock time in the language's 12-hour form (`Intl.DateTimeFormat` hour12).
    pub(crate) time: fn(u32, u32) -> String,
    /// Long weekday names, Monday first.
    pub(crate) weekdays: [&'static str; 7],
}

const KO: Initiated = Initiated {
    removed: "삭제했습니다",
    continued: "계속 진행합니다",
    resolved: "끝나서 이어서 진행합니다",
    taken: "여기서 진행합니다",
    remove: "삭제",
    proceed: "그래도 진행",
    open_other: "그 대화 열기",
    take: "여기서 하기",
    epic_deleted: "과제를 삭제했습니다",
    no_thanks: "괜찮아요",
    sounds_good: "좋아요",
    needs_approval: "확인 필요",
    already_handled: "이미 처리된 제안이에요",
    failed: "처리하지 못했어요. 다시 해 주세요.",
    created: |action| format!("만들었어요 · {action}"),
    skipped: |action| format!("안 만들었어요 · {action}"),
    continuing: |action| format!("계속 받아요 · {action}"),
    paused: |action| format!("멈춰 뒀어요 · {action}"),
    daily_at: |time| format!("매일 {time}"),
    weekdays_at: |time| format!("평일 {time}"),
    unopened: |n| format!("{n}번 연속 안 열어보셨어요"),
    action: |frequency, title| format!("예약 작업 · {frequency} · {title} · 대화로 받아요"),
    weekly_at: |days, time| format!("매주 {days} {time}"),
    interval: "간격",
    once: "한 번",
    pattern_days: |n| format!("최근 {n}일"),
    pattern_weeks: |n| format!("최근 {n}주"),
    pattern_months: |n| format!("최근 {n}개월"),
    pattern_count: |n| format!("{n}번"),
    time: |hour, minute| {
        let half = if hour < 12 { "오전" } else { "오후" };
        format!("{half} {}:{minute:02}", clock_12(hour))
    },
    weekdays: [
        "월요일",
        "화요일",
        "수요일",
        "목요일",
        "금요일",
        "토요일",
        "일요일",
    ],
};

const EN: Initiated = Initiated {
    removed: "Deleted",
    continued: "Continuing",
    resolved: "Finished. Continuing",
    taken: "Continuing here",
    remove: "Delete",
    proceed: "Continue anyway",
    open_other: "Open that conversation",
    take: "Do it here",
    epic_deleted: "Epic deleted",
    no_thanks: "No thanks",
    sounds_good: "Sounds good",
    needs_approval: "Needs your OK",
    already_handled: "This suggestion was already handled",
    failed: "Couldn't complete that. Please try again.",
    created: |action| format!("Created · {action}"),
    skipped: |action| format!("Skipped · {action}"),
    continuing: |action| format!("Continuing · {action}"),
    paused: |action| format!("Paused · {action}"),
    daily_at: |time| format!("Daily at {time}"),
    weekdays_at: |time| format!("Weekdays at {time}"),
    unopened: |n| format!("Unopened {n} times in a row"),
    action: |frequency, title| format!("Schedule · {frequency} · {title} · In Chats"),
    weekly_at: |days, time| format!("Every {days} at {time}"),
    interval: "Interval",
    once: "Once",
    pattern_days: |n| format!("Last {n} days"),
    pattern_weeks: |n| format!("Last {n} weeks"),
    pattern_months: |n| format!("Last {n} months"),
    pattern_count: |n| format!("{n} times"),
    time: |hour, minute| {
        let half = if hour < 12 { "AM" } else { "PM" };
        format!("{}:{minute:02} {half}", clock_12(hour))
    },
    weekdays: [
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
        "Sunday",
    ],
};

fn clock_12(hour: u32) -> u32 {
    match hour % 12 {
        0 => 12,
        other => other,
    }
}

impl Initiated {
    pub(crate) fn of(lang: Lang) -> &'static Self {
        match lang {
            Lang::Ko => &KO,
            Lang::En => &EN,
        }
    }

    pub(crate) fn get(cx: &App) -> &'static Self {
        Self::of(Ds::get(cx).lang())
    }
}
