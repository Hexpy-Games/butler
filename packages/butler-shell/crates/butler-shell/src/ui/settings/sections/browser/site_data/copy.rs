//! The copy of the site data section. Each field names its `packages/butler-i18n` key.
use butler_ds::ui::context::Lang;

pub(super) struct Words {
    /// browser.siteData.title
    pub(super) title: &'static str,
    /// browser.siteData.label
    pub(super) label: &'static str,
    /// browser.siteData.description
    pub(super) description: &'static str,
    /// browser.siteData.clear
    pub(super) clear: &'static str,
    /// browser.siteData.confirmTitle
    pub(super) confirm_title: &'static str,
    /// browser.siteData.confirmMessage
    pub(super) confirm_message: &'static str,
    /// browser.siteData.items
    pub(super) items: &'static str,
    /// browser.siteData.itemList
    pub(super) item_list: &'static str,
    /// browser.siteData.kept
    pub(super) kept: &'static str,
    /// browser.siteData.cleared
    pub(super) cleared: &'static str,
    /// browser.siteData.failed
    pub(super) failed: &'static str,
    /// browser.siteData.desktopOnly
    pub(super) desktop_only: &'static str,
}

static KO: Words = Words {
    title: "사이트 데이터",
    label: "쿠키 및 캐시",
    description: "모든 사이트에서 로그아웃돼요. 저장한 로그인은 남아요.",
    clear: "지우기",
    confirm_title: "쿠키 및 캐시를 지울까요?",
    confirm_message: "버틀러 브라우저의 모든 사이트에서 로그아웃돼요.",
    items: "지울 항목",
    item_list: "쿠키와 사이트 데이터\n캐시된 이미지와 파일",
    kept: "저장한 로그인, 결제 수단, 방문 기록, 북마크는 그대로예요.",
    cleared: "쿠키 및 캐시를 지웠어요",
    failed: "지우지 못했어요",
    desktop_only: "데스크톱 앱에서만 할 수 있어요",
};

static EN: Words = Words {
    title: "Site data",
    label: "Cookies and cache",
    description: "Signs you out of every site. Saved sign-ins stay.",
    clear: "Clear",
    confirm_title: "Clear cookies and cache?",
    confirm_message: "You'll be signed out of every site in Butler's browser.",
    items: "To clear",
    item_list: "Cookies and site data\nCached images and files",
    kept: "Saved sign-ins, payment methods, history and bookmarks stay.",
    cleared: "Cookies and cache cleared",
    failed: "Couldn't clear",
    desktop_only: "Only available in the desktop app",
};

pub(super) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}
