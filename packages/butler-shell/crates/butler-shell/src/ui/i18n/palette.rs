//! The command palette's copy. Each field names its `packages/butler-i18n` key.
use butler_ds::ui::context::Lang;

pub(crate) struct Words {
    /// commandPalette.label, placeholder, close
    pub(crate) label: &'static str,
    pub(crate) placeholder: &'static str,
    pub(crate) close: &'static str,
    /// commandPalette.loading, empty, failed
    pub(crate) loading: &'static str,
    pub(crate) empty: &'static str,
    pub(crate) failed: &'static str,
    /// feedback.retry
    pub(crate) retry: &'static str,
    /// commandPalette.kindLabels: chat, project, project_session, group, automation, settings
    pub(crate) kind_chat: &'static str,
    pub(crate) kind_project: &'static str,
    pub(crate) kind_project_session: &'static str,
    pub(crate) kind_group: &'static str,
    pub(crate) kind_automation: &'static str,
    pub(crate) kind_settings: &'static str,
    /// space.general
    pub(crate) general: &'static str,
    /// settings.logs.trace.openCommand, openCommandHint
    pub(crate) open_logs: &'static str,
    pub(crate) open_logs_hint: &'static str,
    /// automations.once
    pub(crate) once: &'static str,
}

static KO: Words = Words {
    label: "명령 팔레트",
    placeholder: "대화, 프로젝트, 예약 작업, 설정 검색",
    close: "명령 팔레트 닫기",
    loading: "검색 중입니다.",
    empty: "일치하는 항목이 없습니다. 다른 이름이나 제목으로 검색해 보세요.",
    failed: "검색하지 못했습니다. 연결을 확인하고 다시 시도해 주세요.",
    retry: "다시 시도",
    kind_chat: "대화",
    kind_project: "프로젝트",
    kind_project_session: "프로젝트 대화",
    kind_group: "스페이스",
    kind_automation: "예약 작업",
    kind_settings: "설정",
    general: "일반",
    open_logs: "로그 열기",
    open_logs_hint: "최근 메시지 추적",
    once: "한 번",
};

static EN: Words = Words {
    label: "Command palette",
    placeholder: "Search chats, projects, schedules, and settings",
    close: "Close command palette",
    loading: "Searching…",
    empty: "No matches. Try another name or title.",
    failed: "Could not search. Check your connection and try again.",
    retry: "Try again",
    kind_chat: "Chat",
    kind_project: "Project",
    kind_project_session: "Project chat",
    kind_group: "Space",
    kind_automation: "Schedule",
    kind_settings: "Settings",
    general: "General",
    open_logs: "Open logs",
    open_logs_hint: "Latest message trace",
    once: "Once",
};

pub(crate) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}

/// settings.sections, in the order of `visibleSettingsSectionIds` with developer mode on:
/// id, Korean, English.
pub(crate) const SETTINGS_SECTIONS: [(&str, &str, &str); 17] = [
    ("general", "일반", "General"),
    ("appearance", "모양", "Appearance"),
    ("personalization", "개인화", "Personalization"),
    ("memory", "기억", "Memory"),
    ("models", "모델", "Models"),
    ("updates", "업데이트", "Updates"),
    ("usage", "사용량", "Usage"),
    ("logs", "로그", "Logs"),
    ("browser", "브라우저", "Browser"),
    ("security", "보안", "Security"),
    ("system", "시스템 이벤트", "System events"),
    ("archives", "아카이브", "Archives"),
    ("about", "정보", "About"),
    ("mcp", "MCP", "MCP"),
    ("hooks", "훅", "Hooks"),
    ("skills", "스킬", "Skills"),
    ("server", "서버", "Server"),
];

/// automations.everyHours, everyMinutes, everySeconds
pub(crate) fn every(lang: Lang, unit: Every, count: i64) -> String {
    match (lang, unit) {
        (Lang::Ko, Every::Hours) => format!("{count}시간마다"),
        (Lang::Ko, Every::Minutes) => format!("{count}분마다"),
        (Lang::Ko, Every::Seconds) => format!("{count}초마다"),
        (Lang::En, Every::Hours) if count == 1 => "Every hour".to_owned(),
        (Lang::En, Every::Hours) => format!("Every {count} hours"),
        (Lang::En, Every::Minutes) => format!("Every {count} minutes"),
        (Lang::En, Every::Seconds) => format!("Every {count} seconds"),
    }
}

#[derive(Clone, Copy)]
pub(crate) enum Every {
    Hours,
    Minutes,
    Seconds,
}

/// automations.dailyAt, weekdaysAt
pub(crate) fn daily_at(lang: Lang, weekdays: bool, time: &str) -> String {
    match (lang, weekdays) {
        (Lang::Ko, false) => format!("매일 {time}"),
        (Lang::Ko, true) => format!("평일 {time}"),
        (Lang::En, false) => format!("Every day at {time}"),
        (Lang::En, true) => format!("Every weekday at {time}"),
    }
}

/// automations.weeklyAt
pub(crate) fn weekly_at(lang: Lang, days: &str, time: &str) -> String {
    match lang {
        Lang::Ko => format!("매주 {days} {time}"),
        Lang::En => format!("Every {days} at {time}"),
    }
}

/// The long weekday name of day 1 (Monday) to 7 or 0 (Sunday).
pub(crate) fn weekday(lang: Lang, day: i64) -> &'static str {
    let index = usize::try_from(day.rem_euclid(7)).unwrap_or(0);
    match (lang, index) {
        (Lang::Ko, 0) => "일요일",
        (Lang::Ko, 1) => "월요일",
        (Lang::Ko, 2) => "화요일",
        (Lang::Ko, 3) => "수요일",
        (Lang::Ko, 4) => "목요일",
        (Lang::Ko, 5) => "금요일",
        (Lang::Ko, _) => "토요일",
        (Lang::En, 0) => "Sunday",
        (Lang::En, 1) => "Monday",
        (Lang::En, 2) => "Tuesday",
        (Lang::En, 3) => "Wednesday",
        (Lang::En, 4) => "Thursday",
        (Lang::En, 5) => "Friday",
        (Lang::En, _) => "Saturday",
    }
}

/// `Intl.DateTimeFormat` `{ hour: "numeric", minute: "2-digit" }` for a clock time.
pub(crate) fn clock(lang: Lang, hour: i64, minute: i64) -> String {
    let twelve = if hour % 12 == 0 { 12 } else { hour % 12 };
    let pm = hour.rem_euclid(24) >= 12;
    match lang {
        Lang::Ko => format!("{} {twelve}:{minute:02}", if pm { "오후" } else { "오전" }),
        Lang::En => format!("{twelve}:{minute:02} {}", if pm { "PM" } else { "AM" }),
    }
}
