//! The 예약 작업 list and label copy. Each field names its `packages/butler-i18n` key.
use butler_ds::ui::context::Lang;

pub(crate) struct Words {
    /// automations.on
    pub(crate) on: &'static str,
    /// automations.off
    pub(crate) off: &'static str,
    /// automations.once
    pub(crate) once: &'static str,
    /// automations.next
    pub(crate) next: fn(&str) -> String,
    /// automations.everyMinutes
    pub(crate) every_minutes: fn(i64) -> String,
    /// automations.everyHours
    pub(crate) every_hours: fn(i64) -> String,
    /// automations.everySeconds
    pub(crate) every_seconds: fn(i64) -> String,
    /// automations.dailyAt
    pub(crate) daily_at: fn(&str) -> String,
    /// automations.weekdaysAt
    pub(crate) weekdays_at: fn(&str) -> String,
    /// automations.weeklyAt
    pub(crate) weekly_at: fn(&str, &str) -> String,
    /// `Intl` long weekday names, Sunday first
    pub(crate) weekday_names: [&'static str; 7],
    /// automations.new
    pub(crate) new: &'static str,
    /// automations.empty
    pub(crate) empty: &'static str,
    /// automations.scheduledCount
    pub(crate) scheduled_count: fn(usize) -> String,
    /// automations.loginHint
    pub(crate) login_hint: &'static str,
    /// interfacePanels.automationLoadFailed
    pub(crate) load_failed: &'static str,
    /// `Intl` month names, short
    pub(crate) month: fn(u32) -> String,
}

static KO: Words = Words {
    on: "켜짐",
    off: "꺼짐",
    once: "한 번",
    next: |time| format!("다음: {time}"),
    every_minutes: |count| format!("{count}분마다"),
    every_hours: |count| format!("{count}시간마다"),
    every_seconds: |count| format!("{count}초마다"),
    daily_at: |time| format!("매일 {time}"),
    weekdays_at: |time| format!("평일 {time}"),
    weekly_at: |days, time| format!("매주 {days} {time}"),
    weekday_names: [
        "일요일",
        "월요일",
        "화요일",
        "수요일",
        "목요일",
        "금요일",
        "토요일",
    ],
    new: "새 예약 작업",
    empty: "아직 예약 작업이 없습니다",
    scheduled_count: |count| format!("예약된 프롬프트 {count}개"),
    login_hint: "예약 작업을 위해 로그인 시 시작을 켜세요. 설정 → 일반.",
    load_failed: "예약 작업 조회 실패",
    month: |month| format!("{month}월"),
};

static EN: Words = Words {
    on: "On",
    off: "Off",
    once: "Once",
    next: |time| format!("Next: {time}"),
    every_minutes: |count| format!("Every {count} minutes"),
    every_hours: |count| match count {
        1 => "Every hour".to_owned(),
        _ => format!("Every {count} hours"),
    },
    every_seconds: |count| format!("Every {count} seconds"),
    daily_at: |time| format!("Every day at {time}"),
    weekdays_at: |time| format!("Every weekday at {time}"),
    weekly_at: |days, time| format!("Every {days} at {time}"),
    weekday_names: [
        "Sunday",
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
    ],
    new: "New schedule",
    empty: "No schedules yet",
    scheduled_count: |count| format!("{count} scheduled prompts"),
    login_hint: "Start at login for your schedules. Settings → General.",
    load_failed: "Schedule load failed",
    month: |month| {
        const NAMES: [&str; 12] = [
            "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
        ];
        NAMES
            .get((month as usize).saturating_sub(1))
            .copied()
            .unwrap_or_default()
            .to_owned()
    },
};

pub(crate) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}
