//! The copy of the history section. Each field names its `packages/butler-i18n` key.
use butler_ds::ui::context::Lang;

pub(super) struct Words {
    /// browser.history.title
    pub(super) title: &'static str,
    /// browser.history.pageLabel
    pub(super) label: &'static str,
    /// browser.history.pageDescription
    pub(super) description: &'static str,
    /// browser.view
    pub(super) view: &'static str,
    /// browser.history.erase
    pub(super) erase: &'static str,
    /// browser.history.clear
    pub(super) clear: &'static str,
    /// browser.history.butlerOnly
    pub(super) butler_only: &'static str,
    /// browser.history.{hour,today,week,all}
    pub(super) ranges: [(&'static str, &'static str); 4],
    /// browser.cancel
    pub(super) cancel: &'static str,
    /// browser.remove
    pub(super) remove: &'static str,
    /// browser.failed
    pub(super) failed: &'static str,
}

static KO: Words = Words {
    title: "방문 기록",
    label: "방문한 페이지",
    description: "버틀러 브라우저에서 연 페이지 기록을 보거나 지웁니다.",
    view: "보기",
    erase: "지우기",
    clear: "방문 기록 지우기",
    butler_only: "버틀러가 방문",
    ranges: [
        ("hour", "지난 1시간"),
        ("today", "오늘"),
        ("week", "지난 7일"),
        ("all", "전체"),
    ],
    cancel: "취소",
    remove: "삭제",
    failed: "페이지를 열지 못함",
};

static EN: Words = Words {
    title: "History",
    label: "Visited pages",
    description: "View or clear the pages opened in Butler's browser.",
    view: "View",
    erase: "Clear",
    clear: "Clear browsing history",
    butler_only: "Visited by Butler",
    ranges: [
        ("hour", "Last hour"),
        ("today", "Today"),
        ("week", "Last 7 days"),
        ("all", "All time"),
    ],
    cancel: "Cancel",
    remove: "Delete",
    failed: "Could not open page",
};

pub(super) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}
