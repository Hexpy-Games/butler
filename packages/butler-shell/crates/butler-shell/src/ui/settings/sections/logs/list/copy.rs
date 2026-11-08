//! The copy of the log list (`appCopy.settings.logs`, and the few strings of other groups the
//! list shows). Each field names its `packages/butler-i18n` key.
use butler_ds::ui::context::{Ds, Lang};
use gpui::App;

pub(super) struct LogsCopy {
    /// settings.logs.sections.level
    pub(super) section_level: &'static str,
    /// settings.logs.sections.viewer
    pub(super) section_viewer: &'static str,
    /// settings.logs.levelLabel
    pub(super) level_label: &'static str,
    /// settings.logs.levels: minimal, standard, detailed, full
    pub(super) levels: [&'static str; 4],
    /// settings.logs.levelMeta: minimal, standard, detailed, full
    pub(super) level_meta: [&'static str; 4],
    /// settings.logs.fullConfirmTitle
    pub(super) full_confirm_title: &'static str,
    /// settings.logs.fullConfirmBody
    pub(super) full_confirm_body: &'static str,
    /// settings.logs.fullConfirm
    pub(super) full_confirm: &'static str,
    /// settings.logs.fullActive
    pub(super) full_active: fn(u64) -> String,
    /// settings.logs.turnOff
    pub(super) turn_off: &'static str,
    /// settings.logs.freed
    pub(super) freed: fn(&str) -> String,
    /// settings.logs.categories
    pub(super) categories: &'static str,
    /// settings.logs.categoriesChanged
    pub(super) categories_changed: fn(usize) -> String,
    /// settings.logs.categoryInherit
    pub(super) category_inherit: &'static str,
    /// settings.logs.severity: error, warn, info, debug, trace
    pub(super) severity: [&'static str; 5],
    /// settings.logs.search
    pub(super) search: &'static str,
    /// settings.logs.allLevels
    pub(super) all_levels: &'static str,
    /// settings.logs.allSources
    pub(super) all_sources: &'static str,
    /// settings.logs.allCategories
    pub(super) all_categories: &'static str,
    /// settings.logs.sources: app, agent
    pub(super) sources: [&'static str; 2],
    /// settings.logs.periods: hour, day, week, all
    pub(super) periods: [&'static str; 4],
    /// settings.logs.live
    pub(super) live: &'static str,
    /// settings.logs.liveLost
    pub(super) live_lost: &'static str,
    /// settings.logs.empty
    pub(super) empty: &'static str,
    /// settings.logs.loadFailed
    pub(super) load_failed: &'static str,
    /// settings.logs.tabs: request, response, json
    pub(super) tabs: [&'static str; 3],
    /// settings.logs.fields.time
    pub(super) time: &'static str,
    /// settings.logs.fields.message
    pub(super) message: &'static str,
    /// settings.logs.fields.event
    pub(super) event: &'static str,
    /// settings.logs.fields.trace
    pub(super) trace: &'static str,
    /// settings.logs.fields.span
    pub(super) span: &'static str,
    /// settings.logs.fields.chat
    pub(super) chat: &'static str,
    /// settings.logs.fields.turn
    pub(super) turn: &'static str,
    /// settings.logs.fields.error
    pub(super) error: &'static str,
    /// settings.logs.fields.method
    pub(super) method: &'static str,
    /// settings.logs.fields.url
    pub(super) url: &'static str,
    /// settings.logs.fields.status
    pub(super) status: &'static str,
    /// settings.logs.fields.duration
    pub(super) duration: &'static str,
    /// settings.logs.fields.headers
    pub(super) headers: &'static str,
    /// settings.logs.fields.body
    pub(super) body: &'static str,
    /// settings.logs.bodyUnavailable
    pub(super) body_unavailable: &'static str,
    /// settings.logs.bodyFailed
    pub(super) body_failed: &'static str,
    /// settings.logs.copy
    pub(super) copy: &'static str,
    /// settings.logs.copied
    pub(super) copied: &'static str,
    /// settings.logs.copyJson
    pub(super) copy_json: &'static str,
    /// settings.logs.trace.viewWhole
    pub(super) view_whole: &'static str,
    /// common.more
    pub(super) more: &'static str,
    /// interfaceDetails.contextEstimates
    pub(super) context_estimates: &'static str,
    /// composer.usage.day
    pub(super) usage_day: &'static str,
    /// interfacePanels.usageFailed
    pub(super) usage_failed: &'static str,
    /// composer.usage.noUsage
    pub(super) no_usage: &'static str,
    /// interfaceDetails.requests
    pub(super) requests: &'static str,
    /// interfaceDetails.characters
    pub(super) characters: &'static str,
}

const KO: LogsCopy = LogsCopy {
    section_level: "기록",
    section_viewer: "목록",
    level_label: "기록 수준",
    levels: ["최소", "기본", "자세히", "전체"],
    level_meta: [
        "경고와 오류만",
        "단계와 시간, 내용 제외",
        "헤더·크기 포함, 내용 제외",
        "프롬프트·응답·본문 포함",
    ],
    full_confirm_title: "전체 기록을 켤까요?",
    full_confirm_body: "대화 내용과 요청 본문을 이 기기에 저장합니다. 60분 뒤 꺼집니다.",
    full_confirm: "켜기",
    full_active: |minutes| format!("전체 기록 중 · {minutes}분 남음"),
    turn_off: "끄기",
    freed: |size| format!("{size}를 비웠습니다."),
    categories: "분류별 수준",
    categories_changed: |count| format!("{count}개 변경"),
    category_inherit: "기본 따름",
    severity: ["오류", "경고", "정보", "디버그", "추적"],
    search: "메시지, 오류, ID 검색",
    all_levels: "모든 수준",
    all_sources: "모든 출처",
    all_categories: "모든 분류",
    sources: ["앱", "에이전트"],
    periods: ["1시간", "24시간", "7일", "전체 기간"],
    live: "실시간",
    live_lost: "실시간 연결 끊김",
    empty: "기록이 없습니다",
    load_failed: "로그를 불러오지 못했습니다",
    tabs: ["요청", "응답", "JSON"],
    time: "시간",
    message: "메시지",
    event: "이벤트",
    trace: "추적 ID",
    span: "스팬 ID",
    chat: "대화 ID",
    turn: "턴 ID",
    error: "오류",
    method: "메서드",
    url: "주소",
    status: "상태",
    duration: "소요 시간",
    headers: "헤더",
    body: "본문",
    body_unavailable: "본문 · 전체 수준에서만 기록",
    body_failed: "본문을 불러오지 못했습니다",
    copy: "복사",
    copied: "복사함",
    copy_json: "JSON 복사",
    view_whole: "메시지 전체 보기",
    more: "더보기",
    context_estimates: "컨텍스트 섹션별 추정",
    usage_day: "24시간",
    usage_failed: "사용량을 불러오지 못했습니다.",
    no_usage: "사용 없음",
    requests: "요청",
    characters: "문자",
};

const EN: LogsCopy = LogsCopy {
    section_level: "Recording",
    section_viewer: "Entries",
    level_label: "Log level",
    levels: ["Minimal", "Standard", "Detailed", "Full"],
    level_meta: [
        "Warnings and errors only",
        "Steps and timings, no content",
        "Adds headers and sizes, no content",
        "Includes prompts, replies and bodies",
    ],
    full_confirm_title: "Turn on full logging?",
    full_confirm_body: "Chat content and request bodies are saved on this device. Turns off after 60 minutes.",
    full_confirm: "Turn on",
    full_active: |minutes| format!("Full logging · {minutes} min left"),
    turn_off: "Turn off",
    freed: |size| format!("Freed {size}."),
    categories: "Category levels",
    categories_changed: |count| format!("{count} changed"),
    category_inherit: "Default",
    severity: ["Error", "Warning", "Info", "Debug", "Trace"],
    search: "Search messages, errors, IDs",
    all_levels: "All levels",
    all_sources: "All sources",
    all_categories: "All categories",
    sources: ["App", "Agent"],
    periods: ["1 hour", "24 hours", "7 days", "All time"],
    live: "Live",
    live_lost: "Live stream lost",
    empty: "No logs",
    load_failed: "Couldn't load logs",
    tabs: ["Request", "Response", "JSON"],
    time: "Time",
    message: "Message",
    event: "Event",
    trace: "Trace ID",
    span: "Span ID",
    chat: "Chat ID",
    turn: "Turn ID",
    error: "Error",
    method: "Method",
    url: "URL",
    status: "Status",
    duration: "Duration",
    headers: "Headers",
    body: "Body",
    body_unavailable: "Body · recorded at Full only",
    body_failed: "Couldn't load the body",
    copy: "Copy",
    copied: "Copied",
    copy_json: "Copy JSON",
    view_whole: "View whole message",
    more: "More",
    context_estimates: "Estimates by context section",
    usage_day: "24 hours",
    usage_failed: "Usage monitor failed.",
    no_usage: "No usage",
    requests: "Requests",
    characters: "Characters",
};

pub(super) fn words(lang: Lang) -> &'static LogsCopy {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}

/// The copy of the app language.
pub(super) fn get(cx: &App) -> &'static LogsCopy {
    words(Ds::get(cx).lang())
}
