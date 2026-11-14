//! Browser copy from packages/butler-i18n/src/locales/{ko,en}.ts.
use butler_ds::ui::context::{Ds, Lang};
use gpui::App;

pub(crate) struct BrowserStrings {
    pub(crate) title: &'static str,
    pub(crate) my_tabs: &'static str,
    pub(crate) new_tab: &'static str,
    pub(crate) close_tab: &'static str,
    pub(crate) address: &'static str,
    pub(crate) address_placeholder: &'static str,
    pub(crate) back: &'static str,
    pub(crate) forward: &'static str,
    pub(crate) reload: &'static str,
    pub(crate) stop: &'static str,
    pub(crate) crashed: &'static str,
    pub(crate) update_required: &'static str,
    pub(crate) failed: &'static str,
    pub(crate) show: &'static str,
    pub(crate) hide: &'static str,
    pub(crate) pick: &'static str,
    pub(crate) more: &'static str,
    pub(crate) secure: &'static str,
    pub(crate) not_secure: &'static str,
    pub(crate) agent_control: &'static str,
    pub(crate) waiting: &'static str,
    pub(crate) new_tab_in: &'static str,
    pub(crate) more_tabs: &'static str,
    pub(crate) history: &'static str,
}

const KO: BrowserStrings = BrowserStrings {
    title: "브라우저",
    my_tabs: "내 탭",
    new_tab: "새 탭",
    close_tab: "탭 닫기",
    address: "주소",
    address_placeholder: "검색 또는 URL 입력",
    back: "뒤로",
    forward: "앞으로",
    reload: "새로고침",
    stop: "중지",
    crashed: "탭이 중단됨",
    update_required: "버틀러 업데이트 필요",
    failed: "페이지를 열지 못함",
    show: "브라우저 열기",
    hide: "브라우저 닫기",
    pick: "요소 선택",
    more: "더 보기",
    secure: "안전한 연결",
    not_secure: "주의 요함",
    agent_control: "버틀러가 사용 중",
    waiting: "승인 대기",
    new_tab_in: "{group}에 새 탭",
    more_tabs: "+{count}",
    history: "방문 기록",
};

const EN: BrowserStrings = BrowserStrings {
    title: "Browser",
    my_tabs: "My tabs",
    new_tab: "New tab",
    close_tab: "Close tab",
    address: "Address",
    address_placeholder: "Search or enter URL",
    back: "Back",
    forward: "Forward",
    reload: "Reload",
    stop: "Stop",
    crashed: "Tab crashed",
    update_required: "Update Butler",
    failed: "Could not open page",
    show: "Show browser",
    hide: "Hide browser",
    pick: "Pick elements",
    more: "More",
    secure: "Secure connection",
    not_secure: "Not secure",
    agent_control: "Butler is browsing",
    waiting: "Waiting for approval",
    new_tab_in: "New tab in {group}",
    more_tabs: "+{count}",
    history: "History",
};

impl BrowserStrings {
    pub(crate) fn get(cx: &App) -> &'static Self {
        Self::words(Ds::get(cx).lang())
    }
    pub(crate) fn words(lang: Lang) -> &'static Self {
        match lang {
            Lang::Ko => &KO,
            Lang::En => &EN,
        }
    }
}
