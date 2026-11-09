//! The copy of the history page. Each field names its `packages/butler-i18n` key.
use butler_ds::ui::context::Lang;

pub(super) struct Words {
    /// browser.history.search
    pub(super) search: &'static str,
    /// browser.history.butlerOnly
    pub(super) butler_only: &'static str,
    /// browser.history.clear
    pub(super) clear: &'static str,
    /// browser.history.empty
    pub(super) empty: &'static str,
    /// browser.history.{hour,today,week,all}
    pub(super) ranges: [(&'static str, &'static str); 4],
    /// library.select
    pub(super) select: &'static str,
    /// library.selected(count)
    pub(super) selected: fn(usize) -> String,
    /// browser.cancel
    pub(super) cancel: &'static str,
    /// browser.remove
    pub(super) remove: &'static str,
    /// browser.loading
    pub(super) loading: &'static str,
    /// browser.failed
    pub(super) failed: &'static str,
    /// browser.loadMore
    pub(super) load_more: &'static str,
    /// browser.openConversation
    pub(super) open_conversation: &'static str,
    /// Day names, Sunday first (`toLocaleDateString` `weekday: "long"`).
    pub(super) weekdays: [&'static str; 7],
    /// Month names (`month: "long"`).
    pub(super) months: [&'static str; 12],
}

static KO: Words = Words {
    search: "방문 기록 검색",
    butler_only: "버틀러가 방문",
    clear: "방문 기록 지우기",
    empty: "방문 기록 없음",
    ranges: [
        ("hour", "지난 1시간"),
        ("today", "오늘"),
        ("week", "지난 7일"),
        ("all", "전체"),
    ],
    select: "선택",
    selected: |count| format!("{count}개 선택됨"),
    cancel: "취소",
    remove: "삭제",
    loading: "로딩 중",
    failed: "페이지를 열지 못함",
    load_more: "더 보기",
    open_conversation: "대화 열기",
    weekdays: [
        "일요일",
        "월요일",
        "화요일",
        "수요일",
        "목요일",
        "금요일",
        "토요일",
    ],
    months: [
        "1월", "2월", "3월", "4월", "5월", "6월", "7월", "8월", "9월", "10월", "11월", "12월",
    ],
};

static EN: Words = Words {
    search: "Search history",
    butler_only: "Visited by Butler",
    clear: "Clear browsing history",
    empty: "No visits",
    ranges: [
        ("hour", "Last hour"),
        ("today", "Today"),
        ("week", "Last 7 days"),
        ("all", "All time"),
    ],
    select: "Select",
    selected: |count| format!("{count} selected"),
    cancel: "Cancel",
    remove: "Delete",
    loading: "Loading",
    failed: "Could not open page",
    load_more: "More",
    open_conversation: "Open conversation",
    weekdays: [
        "Sunday",
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
    ],
    months: [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
    ],
};

pub(super) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}
