//! The provider list's copy; each field names its `packages/butler-i18n` key.
use butler_ds::ui::context::Lang;

/// Card texts are in `CardId` order.
pub(super) struct Words {
    /// firstRun.connectTitle
    pub(super) title: &'static str,
    /// firstRun.connectLede
    pub(super) lede: &'static str,
    /// firstRun.prepWaitConnect
    pub(super) prep_wait: &'static str,
    /// firstRun.providerNames
    pub(super) names: [&'static str; 11],
    /// firstRun.providerDescriptions
    pub(super) descriptions: [&'static str; 11],
    /// firstRun.tagCurrent
    pub(super) current: &'static str,
    /// firstRun.showLess
    pub(super) show_less: &'static str,
    /// firstRun.offline
    pub(super) offline: &'static str,
    /// firstRun.offlineShort
    pub(super) offline_short: &'static str,
    /// firstRun.offlineTile
    pub(super) offline_tile: &'static str,
}

const KO: Words = Words {
    title: "어떤 AI와 일할까요?",
    lede: "하나만 고르면 바로 시작합니다. 나중에 설정에서 바꿀 수 있습니다.",
    prep_wait: "버틀러 준비가 끝나면 바로 연결합니다",
    names: [
        "ChatGPT",
        "Claude",
        "Gemini",
        "OpenAI API",
        "Grok",
        "Qwen",
        "Kimi",
        "Z.AI 코딩 플랜",
        "Z.AI API",
        "OpenCode Go",
        "기타 (OpenAI 호환)",
    ],
    descriptions: [
        "ChatGPT로 계속하기",
        "Anthropic API 키로 연결",
        "Google AI Studio 키로 연결",
        "OpenAI API 키",
        "xAI API 키",
        "Qwen Cloud API 키",
        "Moonshot API 키",
        "코딩 플랜 키",
        "Z.AI API 키",
        "OpenCode Go 키",
        "Ollama·LM Studio·직접 서버",
    ],
    current: "사용 중",
    show_less: "접기",
    offline: "인터넷에 연결되어 있지 않습니다. 지금은 이 컴퓨터의 모델만 쓸 수 있습니다.",
    offline_short: "오프라인에서는 쓸 수 없습니다",
    offline_tile: "오프라인",
};

const EN: Words = Words {
    title: "Which AI should Butler use?",
    lede: "Pick one to get started. You can change it later in Settings.",
    prep_wait: "Connects as soon as Butler is ready",
    names: [
        "ChatGPT",
        "Claude",
        "Gemini",
        "OpenAI API",
        "Grok",
        "Qwen",
        "Kimi",
        "Z.AI Coding Plan",
        "Z.AI API",
        "OpenCode Go",
        "Other (OpenAI-compatible)",
    ],
    descriptions: [
        "Continue with ChatGPT",
        "Use an Anthropic API key",
        "Use a Google AI Studio key",
        "OpenAI API key",
        "xAI API key",
        "Qwen Cloud API key",
        "Moonshot API key",
        "Coding Plan key",
        "Z.AI API key",
        "OpenCode Go key",
        "Ollama, LM Studio or your own server",
    ],
    current: "In use",
    show_less: "Show less",
    offline: "You're offline. Only models on this computer work right now.",
    offline_short: "Unavailable offline",
    offline_tile: "Offline",
};

pub(super) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}

/// firstRun.localModelCount
pub(super) fn local_model_count(lang: Lang, count: usize) -> String {
    match (lang, count) {
        (Lang::Ko, count) => format!("모델 {count}개"),
        (Lang::En, 1) => "1 model".into(),
        (Lang::En, count) => format!("{count} models"),
    }
}

/// firstRun.moreProviders
pub(super) fn more_providers(lang: Lang, count: usize) -> String {
    match lang {
        Lang::Ko => format!("다른 서비스 {count}개"),
        Lang::En => format!("{count} more services"),
    }
}
