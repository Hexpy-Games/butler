//! The commit and reply copy. Each field names its `packages/butler-i18n` key; the shared
//! `back`, `retry` and `finishFailed` live in `onboarding::copy`.
use butler_ds::ui::context::Lang;

pub(super) struct Words {
    /// firstRun.replyTitle
    pub(super) reply_title: &'static str,
    /// firstRun.replyBody
    pub(super) reply_body: &'static str,
    /// firstRun.replyLanguage
    pub(super) reply_language: &'static str,
    /// firstRun.connecting
    pub(super) connecting: &'static str,
    /// firstRun.next
    pub(super) next: &'static str,
    /// interfaceDetails.default: the label of the Worker profile a first connection creates.
    pub(super) default_profile: &'static str,
}

const KO: Words = Words {
    reply_title: "어떤 언어로 답할까요?",
    reply_body: "나중에 설정에서 바꿀 수 있습니다.",
    reply_language: "답변 언어",
    connecting: "연결 중…",
    next: "다음",
    default_profile: "기본",
};

const EN: Words = Words {
    reply_title: "Which language should Butler reply in?",
    reply_body: "You can change this later in Settings.",
    reply_language: "Reply language",
    connecting: "Connecting…",
    next: "Next",
    default_profile: "Default",
};

pub(super) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}
