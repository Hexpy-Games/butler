//! The welcome and consent copy (`firstRun.*`). Each field names its `packages/butler-i18n` key.
use butler_ds::ui::context::Lang;

pub(super) struct Words {
    /// firstRun.welcomeTitle
    pub(super) welcome_title: &'static str,
    /// firstRun.welcomeLede
    pub(super) welcome_lede: &'static str,
    /// firstRun.start
    pub(super) start: &'static str,
    /// firstRun.interfaceLanguage
    pub(super) interface_language: &'static str,
    /// firstRun.agreeBlocked
    pub(super) agree_blocked: &'static str,
    /// firstRun.learnMore
    pub(super) learn_more: &'static str,
    /// firstRun.cancel
    pub(super) cancel: &'static str,
    /// firstRun.consentTitle
    pub(super) consent_title: &'static str,
    /// firstRun.consentItems: (body, caption)
    pub(super) consent_items: [(&'static str, Option<&'static str>); 4],
    /// firstRun.consentProviderLink
    pub(super) consent_provider_link: &'static str,
    /// firstRun.consentClause
    pub(super) consent_clause: &'static str,
    /// firstRun.decline
    pub(super) decline: &'static str,
    /// firstRun.agree
    pub(super) agree: &'static str,
}

const KO: Words = Words {
    welcome_title: "반갑습니다",
    welcome_lede: "버틀러는 이 컴퓨터에서 파일을 정리하고, 명령을 실행하고, 예약 작업을 챙기며 일을 대신합니다.",
    start: "시작하기",
    interface_language: "인터페이스 언어",
    agree_blocked: "버틀러를 시작해야 계속할 수 있습니다",
    learn_more: "자세히",
    cancel: "취소",
    consent_title: "시작하기 전에 확인해 주세요",
    consent_items: [
        ("버틀러는 무료로 제공되는 오픈소스 소프트웨어입니다.", None),
        (
            "버틀러는 이 컴퓨터에서 파일을 만들고, 수정하고, 삭제하고, 명령어를 실행할 수 있습니다.",
            Some("기본값은 작업 전에 승인을 받는 것입니다. 설정에서 이 승인을 줄일 수 있습니다."),
        ),
        (
            "AI 제공자(OpenAI, Anthropic, Google 등)를 사용하면 대화 내용이 해당 제공자에게 전송되며, 제공자의 약관에 따라 처리됩니다. 버틀러는 그 처리에 책임지지 않습니다.",
            None,
        ),
        (
            "대화, 기억, 설정은 이 컴퓨터(~/.butler)에만 저장됩니다.",
            None,
        ),
    ],
    consent_provider_link: "AI 제공자의 데이터 처리 안내 ↗",
    consent_clause: "버틀러는 \"있는 그대로\" 제공됩니다. 사용자의 지시로 버틀러가 이 컴퓨터에서 하는 작업은 사용자의 책임입니다.",
    decline: "동의하지 않음",
    agree: "동의하고 계속",
};

const EN: Words = Words {
    welcome_title: "Welcome to Butler",
    welcome_lede: "Butler works for you on this computer. It organizes files, runs commands and keeps your schedules.",
    start: "Get started",
    interface_language: "Interface language",
    agree_blocked: "Butler needs to start first",
    learn_more: "More details",
    cancel: "Cancel",
    consent_title: "Before you start",
    consent_items: [
        ("Butler is free, open-source software.", None),
        (
            "Butler can create, modify and delete files and run commands on this computer.",
            Some("By default it asks for your approval first. You can loosen this in settings."),
        ),
        (
            "If you use an AI provider (OpenAI, Anthropic, Google, etc.), your conversation is sent to that provider and handled under its terms. Butler is not responsible for that handling.",
            None,
        ),
        (
            "Your conversations, memory and settings are stored only on this computer (~/.butler).",
            None,
        ),
    ],
    consent_provider_link: "How AI providers handle your data ↗",
    consent_clause: "Butler is provided \"as is\". What Butler does on your computer at your direction is your responsibility.",
    decline: "Decline",
    agree: "Agree and continue",
};

pub(super) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}
