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
    /// shell.notYet
    pub(super) not_yet: &'static str,
}

static KO: Words = Words {
    title: "사이트 데이터",
    label: "쿠키 및 캐시",
    description: "모든 사이트에서 로그아웃돼요. 저장한 로그인은 남아요.",
    clear: "지우기",
    not_yet: "준비 중",
};

static EN: Words = Words {
    title: "Site data",
    label: "Cookies and cache",
    description: "Signs you out of every site. Saved sign-ins stay.",
    clear: "Clear",
    not_yet: "Coming soon",
};

pub(super) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}
