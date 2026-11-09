//! The copy of the Usage page. Each field names its `packages/butler-i18n` key (`composer.usage.*`
//! unless it says otherwise); the strings the context popover shares live in
//! `ui/i18n/composer/usage.rs`.
use butler_ds::ui::context::Lang;

pub(super) struct Words {
    /// interfacePanels.usageFailed
    pub(super) usage_failed: &'static str,
    /// common.refresh
    pub(super) refresh: &'static str,
    /// sidebar.newChat
    pub(super) new_chat: &'static str,
    /// chatgptPlan.estimateHint
    pub(super) estimate_hint: &'static str,
    /// interfaceStatus.subscription, apiUsage, unconfirmed
    pub(super) subscription: &'static str,
    pub(super) api_usage: &'static str,
    pub(super) unconfirmed: &'static str,
    pub(super) overview_title: &'static str,
    pub(super) history_title: &'static str,
    pub(super) images_title: &'static str,
    pub(super) images_generated: &'static str,
    pub(super) images_edited: &'static str,
    pub(super) images_cost: &'static str,
    pub(super) images_total: &'static str,
    pub(super) lifetime_tokens: &'static str,
    pub(super) busiest_day: &'static str,
    pub(super) longest_task: &'static str,
    pub(super) longest_streak: &'static str,
    pub(super) current_streak: &'static str,
    pub(super) view_daily: &'static str,
    pub(super) view_weekly: &'static str,
    pub(super) view_cumulative: &'static str,
    pub(super) week_of: fn(&str) -> String,
    pub(super) through_week: fn(&str) -> String,
    pub(super) no_usage: &'static str,
    /// `Intl.DateTimeFormat(locale, { weekday: "short" })`, Sunday first.
    pub(super) weekdays: [&'static str; 7],
    pub(super) days: fn(i64) -> String,
    pub(super) checked_ago: fn(&str) -> String,
    pub(super) resets_in: fn(&str) -> String,
    pub(super) limit_resets_in: fn(&str) -> String,
    pub(super) duration_hours: fn(i64) -> String,
    pub(super) elapsed_minutes: fn(i64) -> String,
    pub(super) limit_reached: &'static str,
    pub(super) pay_as_you_go: &'static str,
    pub(super) this_month: &'static str,
    pub(super) refresh_failed_stale: fn(&str) -> String,
    pub(super) estimated: &'static str,
    pub(super) calls: fn(&str) -> String,
    pub(super) all: &'static str,
    pub(super) trend: &'static str,
    pub(super) chats: &'static str,
    pub(super) models: &'static str,
    pub(super) tools: &'static str,
    pub(super) schedule: &'static str,
    pub(super) butler_task: &'static str,
    pub(super) period: &'static str,
    pub(super) day: &'static str,
    pub(super) week: &'static str,
    pub(super) month: &'static str,
    pub(super) search: &'static str,
    pub(super) usage_order: &'static str,
    pub(super) estimated_cost: &'static str,
    pub(super) share: &'static str,
    pub(super) remaining: &'static str,
    pub(super) previous_period: fn(u32) -> &'static str,
    pub(super) previous_empty: fn(&str) -> String,
    pub(super) delta: fn(&str, &str, bool) -> String,
    pub(super) similar: &'static str,
    pub(super) empty_range: &'static str,
    pub(super) no_records: &'static str,
    pub(super) no_matches: &'static str,
    pub(super) picker_footer: fn(&str) -> String,
    pub(super) view_all: fn(usize) -> String,
    pub(super) failures: fn(&str) -> String,
}

fn en_previous_period(hours: u32) -> &'static str {
    match hours {
        24 => "this time yesterday",
        168 => "the previous 7 days",
        _ => "the previous 30 days",
    }
}

fn ko_previous_period(hours: u32) -> &'static str {
    match hours {
        24 => "어제 같은 시간",
        168 => "직전 7일",
        _ => "직전 30일",
    }
}

static EN: Words = Words {
    usage_failed: "Usage monitor failed.",
    refresh: "Refresh",
    new_chat: "New chat",
    estimate_hint: "Estimated from OpenAI responses",
    subscription: "Subscription",
    api_usage: "API usage",
    unconfirmed: "Unconfirmed",
    overview_title: "Recent usage",
    history_title: "Activity",
    images_title: "Image models",
    images_generated: "Generated",
    images_edited: "Edited",
    images_cost: "Est. cost",
    images_total: "Total",
    lifetime_tokens: "Lifetime tokens",
    busiest_day: "Busiest day",
    longest_task: "Longest task",
    longest_streak: "Longest streak",
    current_streak: "Current streak",
    view_daily: "Daily",
    view_weekly: "Weekly",
    view_cumulative: "Cumulative",
    week_of: |date| format!("Week of {date}"),
    through_week: |date| format!("Through week of {date}"),
    no_usage: "No usage",
    weekdays: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    days: |n| format!("{n} {}", if n == 1 { "day" } else { "days" }),
    checked_ago: |t| format!("Checked {t} ago"),
    resets_in: |t| format!("Resets in {t}"),
    limit_resets_in: |t| format!("Limit reached · resets in {t}"),
    duration_hours: |n| format!("{n}h"),
    elapsed_minutes: |n| format!("{n}m"),
    limit_reached: "Limit reached",
    pay_as_you_go: "Pay-as-you-go",
    this_month: "This month",
    refresh_failed_stale: |t| format!("Couldn't refresh · from {t} ago"),
    estimated: "Estimated",
    calls: |count| format!("{count} {}", if count == "1" { "call" } else { "calls" }),
    all: "All",
    trend: "Usage over time",
    chats: "Chats",
    models: "Models",
    tools: "Tools",
    schedule: "Schedule",
    butler_task: "Butler task",
    period: "Period",
    day: "24 hours",
    week: "7 days",
    month: "30 days",
    search: "Search chats",
    usage_order: "By usage",
    estimated_cost: "Estimated cost",
    share: "Share of all usage",
    remaining: "Remaining limits",
    previous_period: en_previous_period,
    previous_empty: |previous| format!("No records for {previous}"),
    delta: |previous, percent, higher| {
        format!(
            "{percent}% {} than {previous}",
            if higher { "more" } else { "less" }
        )
    },
    similar: "About the same",
    empty_range: "No records in this period",
    no_records: "No records",
    no_matches: "No matching chats",
    picker_footer: |range| format!("Only chats used in the last {range} are shown"),
    view_all: |count| format!("View all {count} chats"),
    failures: |count| {
        if count == "0" {
            "No failures".to_owned()
        } else {
            format!("{count} failed")
        }
    },
};

static KO: Words = Words {
    usage_failed: "사용량을 불러오지 못했습니다.",
    refresh: "새로고침",
    new_chat: "새 대화",
    estimate_hint: "OpenAI 응답 기준 추정치",
    subscription: "구독",
    api_usage: "API 사용량",
    unconfirmed: "확인되지 않음",
    overview_title: "최근 사용량",
    history_title: "사용 기록",
    images_title: "이미지 모델",
    images_generated: "생성",
    images_edited: "편집",
    images_cost: "추정 비용",
    images_total: "합계",
    lifetime_tokens: "누적 토큰",
    busiest_day: "가장 많이 쓴 날",
    longest_task: "가장 긴 작업",
    longest_streak: "최장 연속 사용",
    current_streak: "연속 사용 중",
    view_daily: "일별",
    view_weekly: "주별",
    view_cumulative: "누적",
    week_of: |date| format!("{date} 주"),
    through_week: |date| format!("{date} 주까지"),
    no_usage: "사용 없음",
    weekdays: ["일", "월", "화", "수", "목", "금", "토"],
    days: |n| format!("{n}일"),
    checked_ago: |t| format!("{t} 전 확인"),
    resets_in: |t| format!("{t} 후 재설정"),
    limit_resets_in: |t| format!("한도 도달 · {t} 후 재설정"),
    duration_hours: |n| format!("{n}시간"),
    elapsed_minutes: |n| format!("{n}분"),
    limit_reached: "한도 도달",
    pay_as_you_go: "종량제",
    this_month: "이번 달",
    refresh_failed_stale: |t| format!("조회 실패 · {t} 전 값"),
    estimated: "추정",
    calls: |count| format!("{count}회"),
    all: "전체",
    trend: "사용량 추이",
    chats: "대화",
    models: "모델",
    tools: "도구",
    schedule: "예약 작업",
    butler_task: "버틀러 작업",
    period: "기간",
    day: "24시간",
    week: "7일",
    month: "30일",
    search: "대화 검색",
    usage_order: "사용량순",
    estimated_cost: "추정 비용",
    share: "전체 중",
    remaining: "남은 한도",
    previous_period: ko_previous_period,
    previous_empty: |previous| format!("{previous} 기록 없음"),
    delta: |previous, percent, higher| {
        format!(
            "{previous}보다 {percent}% {}",
            if higher { "많음" } else { "적음" }
        )
    },
    similar: "비슷함",
    empty_range: "이 기간 기록 없음",
    no_records: "기록 없음",
    no_matches: "일치하는 대화가 없습니다",
    picker_footer: |range| format!("{range} 동안 사용한 대화만 표시합니다"),
    view_all: |count| format!("모두 보기 {count}개"),
    failures: |count| {
        if count == "0" {
            "실패 없음".to_owned()
        } else {
            format!("실패 {count}회")
        }
    },
};

pub(super) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}
