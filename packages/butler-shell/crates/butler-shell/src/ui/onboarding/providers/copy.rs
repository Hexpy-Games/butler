//! The provider list's copy; each field names its `packages/butler-i18n` key.
use butler_ds::ui::context::Lang;

use super::CardId;

pub(super) struct Words {
    /// firstRun.connectTitle
    pub(super) title: &'static str,
    /// firstRun.connectLede
    pub(super) lede: &'static str,
    /// firstRun.prepWaitConnect
    pub(super) prep_wait: &'static str,
    /// firstRun.keyLabel
    pub(super) key_card: &'static str,
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
    key_card: "API 키",
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
    key_card: "API key",
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

/// firstRun.providerNames
pub(super) fn known_name(lang: Lang, card: &CardId) -> Option<&'static str> {
    Some(match card {
        CardId::Chatgpt => "ChatGPT",
        CardId::Other => match lang {
            Lang::Ko => "기타 (OpenAI 호환)",
            Lang::En => "Other (OpenAI-compatible)",
        },
        CardId::Key(id) => match id.as_ref() {
            "anthropic" => "Claude",
            "google" => "Gemini",
            "openai" => "OpenAI API",
            "xai" => "Grok",
            "qwen" => "Qwen",
            "kimi" => "Kimi",
            "zai" => match lang {
                Lang::Ko => "Z.AI 코딩 플랜",
                Lang::En => "Z.AI Coding Plan",
            },
            "zai-api" => "Z.AI API",
            "opencode-go" => "OpenCode Go",
            _ => return None,
        },
    })
}

/// firstRun.providerDescriptions
pub(super) fn description(lang: Lang, card: &CardId) -> &'static str {
    match card {
        CardId::Chatgpt => match lang {
            Lang::Ko => "ChatGPT로 계속하기",
            Lang::En => "Continue with ChatGPT",
        },
        CardId::Other => match lang {
            Lang::Ko => "Ollama·LM Studio·직접 서버",
            Lang::En => "Ollama, LM Studio or your own server",
        },
        CardId::Key(id) => match id.as_ref() {
            "anthropic" => match lang {
                Lang::Ko => "Anthropic API 키로 연결",
                Lang::En => "Use an Anthropic API key",
            },
            "google" => match lang {
                Lang::Ko => "Google AI Studio 키로 연결",
                Lang::En => "Use a Google AI Studio key",
            },
            "openai" => match lang {
                Lang::Ko => "OpenAI API 키",
                Lang::En => "OpenAI API key",
            },
            "xai" => match lang {
                Lang::Ko => "xAI API 키",
                Lang::En => "xAI API key",
            },
            "qwen" => match lang {
                Lang::Ko => "Qwen Cloud API 키",
                Lang::En => "Qwen Cloud API key",
            },
            "kimi" => match lang {
                Lang::Ko => "Moonshot API 키",
                Lang::En => "Moonshot API key",
            },
            "zai" => match lang {
                Lang::Ko => "코딩 플랜 키",
                Lang::En => "Coding Plan key",
            },
            "zai-api" => match lang {
                Lang::Ko => "Z.AI API 키",
                Lang::En => "Z.AI API key",
            },
            "opencode-go" => match lang {
                Lang::Ko => "OpenCode Go 키",
                Lang::En => "OpenCode Go key",
            },
            _ => words(lang).key_card,
        },
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
