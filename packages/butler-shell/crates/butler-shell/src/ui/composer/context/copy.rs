//! The context popover's copy (packages/butler-i18n: `composer.usage.*`, `interfacePanels`,
//! `interfaceTemplates`, `interfaceStatus`, `chatgptPlan`), in the DS language.
use butler_ds::ui::context::Lang;

pub(super) struct UsageCopy {
    /// interfacePanels.contextWindow
    pub context_window: &'static str,
    /// interfaceTemplates.contextMetric("full" | "compact")
    pub context_full: fn(i64) -> String,
    pub context_compact: fn(&str) -> String,
    /// interfaceTemplates.resets, expires, remaining
    pub resets: fn(&str) -> String,
    pub expires: fn(&str) -> String,
    pub remaining: fn(&str) -> String,
    /// interfaceStatus
    pub unknown: &'static str,
    pub five_hour: &'static str,
    pub weekly: &'static str,
    pub mcp_monthly: &'static str,
    pub individual: &'static str,
    pub provided_limit: &'static str,
    pub minutes_limit: fn(i64) -> String,
    /// chatgptPlan
    pub limit_reached_plan: &'static str,
    pub plan_resets_at: fn(&str) -> String,
    pub manage_usage: &'static str,
    pub butler_usage: &'static str,
    pub window_5h: &'static str,
    pub window_7d: &'static str,
    pub window_30d: &'static str,
    pub plan_estimate: &'static str,
    /// composer.usage
    pub this_chat: &'static str,
    pub conversation_part: &'static str,
    pub delegated_part: &'static str,
    pub requests: fn(&str) -> String,
    pub tokens: &'static str,
    pub new_input: &'static str,
    pub cached: &'static str,
    pub output: &'static str,
    pub account_limits: &'static str,
    pub now: &'static str,
    pub just_started: &'static str,
    pub no_usage: &'static str,
    pub tiny_cost: &'static str,
    pub tiny_share: &'static str,
    pub details: &'static str,
    pub estimate: &'static str,
    pub left: fn(&str) -> String,
    pub unavailable: &'static str,
    pub loading: &'static str,
    pub updated: fn(&str) -> String,
    pub bucket_unit: fn(u32) -> String,
    pub bucket_hours: fn(i64, i64, bool) -> String,
}

fn en_bucket_unit(hours: u32) -> String {
    if hours < 24 {
        format!("{hours}-hour bars")
    } else {
        format!("{}-day bars", hours / 24)
    }
}

fn ko_bucket_unit(hours: u32) -> String {
    if hours < 24 {
        format!("{hours}시간 단위")
    } else {
        format!("{}일 단위", hours / 24)
    }
}

fn en_bucket_hours(start: i64, end: i64, single: bool) -> String {
    if single {
        format!("{start:02}:00")
    } else {
        format!("{start:02}:00\u{2013}{end:02}:00")
    }
}

fn ko_bucket_hours(start: i64, end: i64, single: bool) -> String {
    if single {
        format!("{start}시")
    } else {
        format!("{start}\u{2013}{end}시")
    }
}

static EN: UsageCopy = UsageCopy {
    context_window: "Context window",
    context_full: |percent| format!("{percent}% full"),
    context_compact: |value| format!("auto compact at {value}"),
    resets: |value| format!("Resets {value}"),
    expires: |value| format!("Expires {value}"),
    remaining: |value| format!("{value} remaining"),
    unknown: "Unknown",
    five_hour: "5-hour limit",
    weekly: "Weekly limit",
    mcp_monthly: "MCP monthly limit",
    individual: "Individual limit",
    provided_limit: "Reported limit",
    minutes_limit: |minutes| format!("{minutes}-minute limit"),
    limit_reached_plan: "Usage limit reached",
    plan_resets_at: |time| format!("Resets {time}"),
    manage_usage: "Manage usage",
    butler_usage: "Butler usage",
    window_5h: "Last 5 hours",
    window_7d: "Last 7 days",
    window_30d: "Last 30 days",
    plan_estimate: "Estimate",
    this_chat: "This chat",
    conversation_part: "Conversation",
    delegated_part: "Subtasks",
    requests: |count| format!("{count} {}", if count == "1" { "request" } else { "requests" }),
    tokens: "tokens",
    new_input: "New input",
    cached: "Cached",
    output: "Output",
    account_limits: "Account limits",
    now: "Now",
    just_started: "Just started",
    no_usage: "No usage",
    tiny_cost: "Less than $0.01",
    tiny_share: "Less than 1%",
    details: "Details",
    estimate: "est.",
    left: |percent| format!("{percent} left"),
    unavailable: "Usage unavailable",
    loading: "Loading usage",
    updated: |time| format!("Updated {time}"),
    bucket_unit: en_bucket_unit,
    bucket_hours: en_bucket_hours,
};

static KO: UsageCopy = UsageCopy {
    context_window: "컨텍스트 창",
    context_full: |percent| format!("{percent}% 사용"),
    context_compact: |value| format!("{value}에서 자동 압축"),
    resets: |value| format!("재설정 {value}"),
    expires: |value| format!("만료 {value}"),
    remaining: |value| format!("{value} 남음"),
    unknown: "미확인",
    five_hour: "5시간 한도",
    weekly: "주간 한도",
    mcp_monthly: "MCP 월간 한도",
    individual: "개별 한도",
    provided_limit: "제공된 한도",
    minutes_limit: |minutes| format!("{minutes}분 한도"),
    limit_reached_plan: "사용 한도 도달",
    plan_resets_at: |time| format!("{time}에 초기화"),
    manage_usage: "사용량 관리",
    butler_usage: "버틀러 사용량",
    window_5h: "최근 5시간",
    window_7d: "최근 7일",
    window_30d: "최근 30일",
    plan_estimate: "추정",
    this_chat: "이 대화",
    conversation_part: "대화",
    delegated_part: "하위 작업",
    requests: |count| format!("요청 {count}회"),
    tokens: "토큰",
    new_input: "새 입력",
    cached: "캐시",
    output: "출력",
    account_limits: "계정 한도",
    now: "진행 중",
    just_started: "방금 시작",
    no_usage: "사용 없음",
    tiny_cost: "$0.01 미만",
    tiny_share: "1% 미만",
    details: "자세히",
    estimate: "추정",
    left: |percent| format!("{percent} 남음"),
    unavailable: "사용량 확인 불가",
    loading: "사용량 불러오는 중",
    updated: |time| format!("{time} 기준"),
    bucket_unit: ko_bucket_unit,
    bucket_hours: ko_bucket_hours,
};

pub(super) fn copy(lang: Lang) -> &'static UsageCopy {
    match lang {
        Lang::En => &EN,
        Lang::Ko => &KO,
    }
}
