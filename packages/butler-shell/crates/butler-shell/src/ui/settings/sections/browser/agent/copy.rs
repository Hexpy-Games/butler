//! The copy of the browsing agent field. Each field names its `packages/butler-i18n` key.
use butler_ds::ui::context::Lang;

pub(super) struct Words {
    /// settings.pageSections.browsing
    pub(super) title: &'static str,
    /// settings.browsingAgent.label
    pub(super) label: &'static str,
    /// settings.browsingAgent.auto, up to the model name
    pub(super) auto_prefix: &'static str,
    /// settings.browsingAgent.off
    pub(super) off: &'static str,
    /// settings.browsingAgent.conversationModel
    pub(super) conversation_model: &'static str,
}

static KO: Words = Words {
    title: "브라우징",
    label: "브라우징 에이전트",
    auto_prefix: "자동 · ",
    off: "사용 안 함",
    conversation_model: "대화 모델",
};

static EN: Words = Words {
    title: "Browsing",
    label: "Browsing agent",
    auto_prefix: "Auto · ",
    off: "Off",
    conversation_model: "conversation model",
};

pub(super) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}
