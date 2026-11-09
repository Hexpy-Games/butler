//! The copy of a 예약 작업's detail (`appCopy.automations`, `common`, `composer`,
//! `interfacePanels` and `settings.deleteSchedule`). Each field names its `packages/butler-i18n`
//! key.
use butler_ds::ui::context::Lang;

pub(super) struct Words {
    /// automations.title
    pub(super) title: &'static str,
    /// automations.new
    pub(super) new_title: &'static str,
    /// automations.detailFallback
    pub(super) detail_fallback: &'static str,
    /// automations.backLabel
    pub(super) back_label: &'static str,
    /// automations.runNow
    pub(super) run_now: &'static str,
    /// automations.resume
    pub(super) resume: &'static str,
    /// automations.pause
    pub(super) pause: &'static str,
    /// automations.saved
    pub(super) saved: &'static str,
    /// automations.saveFailed
    pub(super) save_failed: &'static str,
    /// automations.frequency
    pub(super) frequency: &'static str,
    /// automations.time
    pub(super) time: &'static str,
    /// automations.weekday
    pub(super) weekday: &'static str,
    /// automations.interval, daily, weekdays, weekly, once
    pub(super) kinds: [&'static str; 5],
    /// automations.everyMinutes
    pub(super) every_minutes: fn(i64) -> String,
    /// automations.everyHours
    pub(super) every_hours: fn(i64) -> String,
    /// automations.fields.title
    pub(super) field_title: &'static str,
    /// automations.fields.prompt
    pub(super) field_prompt: &'static str,
    /// automations.fields.details
    pub(super) details: &'static str,
    /// automations.fields.targetChat
    pub(super) target_chat: &'static str,
    /// automations.fields.interval
    pub(super) field_interval: &'static str,
    /// automations.fields.customMinutes
    pub(super) custom_minutes: &'static str,
    /// automations.fields.state
    pub(super) state: &'static str,
    /// automations.placeholders.title, prompt
    pub(super) placeholders: [&'static str; 2],
    /// automations.accessHint
    pub(super) access_hint: &'static str,
    /// automations.browser: title, signin, signinDescription, payment, paymentDescription,
    /// unavailable
    pub(super) browser: [&'static str; 6],
    /// automations.errors.invalid
    pub(super) error_invalid: &'static str,
    /// common.save
    pub(super) save: &'static str,
    /// common.delete
    pub(super) delete: &'static str,
    /// common.cancel
    pub(super) cancel: &'static str,
    /// common.more
    pub(super) more: &'static str,
    /// common.breadcrumb
    pub(super) breadcrumb: &'static str,
    /// composer.permission
    pub(super) permission: &'static str,
    /// composer.model
    pub(super) model: &'static str,
    /// settings.options.consolidationModelDefault
    pub(super) model_default: &'static str,
    /// interfacePanels.generalChat
    pub(super) general_chat: &'static str,
    /// interfacePanels.custom
    pub(super) custom: &'static str,
    /// interfacePanels.automationDetailFailed
    pub(super) detail_failed: &'static str,
    /// settings.deleteSchedule
    pub(super) delete_schedule: fn(&str) -> String,
    /// settings.pickTime
    pub(super) pick_time: &'static str,
    /// `scheduleWeekday` (long weekday names, Monday = 1)
    pub(super) weekdays: [&'static str; 7],
    /// automationStore.ts: `${action} failed` for run, pause, resume
    pub(super) action_failed: fn(&str) -> String,
    /// automationStore.ts: "Delete failed"
    pub(super) delete_failed: &'static str,
}

const KO: Words = Words {
    title: "예약 작업",
    new_title: "새 예약 작업",
    detail_fallback: "상세",
    back_label: "예약 작업 목록으로 돌아가기",
    run_now: "지금 실행",
    resume: "재개",
    pause: "일시정지",
    saved: "예약 작업 저장됨",
    save_failed: "예약 작업 저장 실패",
    frequency: "주기",
    time: "시간",
    weekday: "요일",
    kinds: ["간격", "매일", "평일", "매주", "한 번"],
    every_minutes: |count| format!("{count}분마다"),
    every_hours: |count| format!("{count}시간마다"),
    field_title: "제목",
    field_prompt: "프롬프트",
    details: "세부 정보",
    target_chat: "대상 대화",
    field_interval: "간격",
    custom_minutes: "사용자 지정 분",
    state: "상태",
    placeholders: ["예약 작업 제목", "프롬프트 내용"],
    access_hint: "예약 실행 중 확인이 필요한 단계는 건너뛰고 알려 드립니다.",
    browser: [
        "브라우저",
        "로그인 정보 사용",
        "허용한 사이트에 로그인 상태로 접속합니다.",
        "결제 정보 사용",
        "확인 없이 결제로 둔 사이트에서 결제합니다.",
        "이 컴퓨터에서 사용 불가",
    ],
    error_invalid: "입력값을 확인해 주세요.",
    save: "저장",
    delete: "삭제",
    cancel: "취소",
    more: "더보기",
    breadcrumb: "현재 위치",
    permission: "권한",
    model: "모델",
    model_default: "모델 기본값",
    general_chat: "일반 대화",
    custom: "직접 지정",
    detail_failed: "예약 작업 상세 조회 실패",
    delete_schedule: |name| format!("예약 작업 \"{name}\"을 삭제합니다."),
    pick_time: "시간 고르기",
    weekdays: [
        "월요일",
        "화요일",
        "수요일",
        "목요일",
        "금요일",
        "토요일",
        "일요일",
    ],
    action_failed: |action| format!("{action} failed"),
    delete_failed: "Delete failed",
};

const EN: Words = Words {
    title: "Schedules",
    new_title: "New schedule",
    detail_fallback: "Details",
    back_label: "Back to schedules",
    run_now: "Run now",
    resume: "Resume",
    pause: "Pause",
    saved: "Schedule saved",
    save_failed: "Schedule save failed",
    frequency: "Frequency",
    time: "Time",
    weekday: "Day",
    kinds: ["Interval", "Daily", "Weekdays", "Weekly", "Once"],
    every_minutes: |count| format!("Every {count} minutes"),
    every_hours: |count| {
        if count == 1 {
            "Every hour".to_owned()
        } else {
            format!("Every {count} hours")
        }
    },
    field_title: "Title",
    field_prompt: "Prompt",
    details: "Details",
    target_chat: "Target chat",
    field_interval: "Interval",
    custom_minutes: "Custom minutes",
    state: "State",
    placeholders: ["Schedule title", "Prompt body"],
    access_hint: "Scheduled runs skip steps that need approval and let you know.",
    browser: [
        "Browser",
        "Use sign-in info",
        "Opens sites you allowed, signed in.",
        "Use payment info",
        "Pays on sites set to pay without asking.",
        "Unavailable on this computer",
    ],
    error_invalid: "Check the fields.",
    save: "Save",
    delete: "Delete",
    cancel: "Cancel",
    more: "More",
    breadcrumb: "Location",
    permission: "Permission",
    model: "Model",
    model_default: "Model default",
    general_chat: "General chat",
    custom: "Custom",
    detail_failed: "Schedule detail failed",
    delete_schedule: |name| format!("Delete schedule \"{name}\"."),
    pick_time: "Choose time",
    weekdays: [
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
        "Sunday",
    ],
    action_failed: |action| format!("{action} failed"),
    delete_failed: "Delete failed",
};

pub(super) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}
