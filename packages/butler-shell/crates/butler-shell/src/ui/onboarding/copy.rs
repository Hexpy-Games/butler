//! The onboarding copy every step shares. Each field names its `packages/butler-i18n` key; each
//! unit keeps its own copy beside it.
use butler_ds::ui::context::Lang;

pub(crate) struct Words {
    /// firstRun.product
    pub(crate) product: &'static str,
    /// firstRun.back
    pub(crate) back: &'static str,
    /// firstRun.retry
    pub(crate) retry: &'static str,
    /// firstRun.finishFailed
    pub(crate) finish_failed: &'static str,
    /// firstRun.steps.{welcome, consent, memory, connect, ready}
    pub(crate) steps: [&'static str; 5],
    /// settings.pageSections.import
    pub(crate) import: &'static str,
}

const KO: Words = Words {
    product: "버틀러",
    back: "이전",
    retry: "다시 시도",
    finish_failed: "연결을 마치지 못했습니다. 다시 시도하세요.",
    steps: ["환영", "동의", "기억 방식", "AI 연결", "마무리"],
    import: "가져오기",
};

const EN: Words = Words {
    product: "Butler",
    back: "Back",
    retry: "Try again",
    finish_failed: "Couldn't finish connecting. Try again.",
    steps: ["Welcome", "Consent", "Memory", "Connect AI", "Finish"],
    import: "Import",
};

pub(crate) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}
