//! The key form and Other copy (KO/EN). Each field names its `packages/butler-i18n` key.
use butler_ds::ui::context::Lang;

pub(super) struct Words {
    /// firstRun.keyTitle
    pub(super) key_title: fn(&str) -> String,
    /// firstRun.keyLabel
    pub(super) key_label: &'static str,
    /// firstRun.keyHint
    pub(super) key_hint: &'static str,
    /// firstRun.keyValid
    pub(super) key_valid: &'static str,
    /// firstRun.keySaved
    pub(super) key_saved: &'static str,
    /// firstRun.keyStored
    pub(super) key_stored: &'static str,
    /// firstRun.getKey
    pub(super) get_key: &'static str,
    /// firstRun.keyErrors.{invalid, noaccess, network, ratelimited, unavailable, unsupported,
    /// badrequest, savefailed}, in `Failure` order
    pub(super) key_errors: [&'static str; 8],
    /// firstRun.next
    pub(super) next: &'static str,
    /// firstRun.connectFirst
    pub(super) connect_first: &'static str,
    /// firstRun.connecting
    pub(super) connecting: &'static str,
    /// firstRun.checking
    pub(super) checking: &'static str,
    /// firstRun.otherTitle
    pub(super) other_title: &'static str,
    /// firstRun.otherBody
    pub(super) other_body: &'static str,
    /// firstRun.otherServer
    pub(super) other_server: &'static str,
    /// firstRun.localNote
    pub(super) local_note: &'static str,
    /// firstRun.localMissing
    pub(super) local_missing: &'static str,
    /// firstRun.rescan
    pub(super) rescan: &'static str,
    /// firstRun.noModels
    pub(super) no_models: &'static str,
    /// firstRun.customTitle
    pub(super) custom_title: &'static str,
    /// firstRun.customBody
    pub(super) custom_body: &'static str,
    /// firstRun.customUrl
    pub(super) custom_url: &'static str,
    /// firstRun.customKey
    pub(super) custom_key: &'static str,
    /// firstRun.customConnect
    pub(super) custom_connect: &'static str,
}

const KO: Words = Words {
    key_title: |name| format!("{name} 연결"),
    key_label: "API 키",
    key_hint: "붙여 넣으면 바로 확인합니다.",
    key_valid: "연결되었습니다",
    key_saved: "저장했습니다",
    key_stored: "키는 이 컴퓨터에만 저장됩니다.",
    get_key: "키 발급받기",
    key_errors: [
        "이 키로 연결할 수 없습니다. 키를 다시 복사해 붙여 넣으세요.",
        "이 키로는 모델을 쓸 수 없습니다. 결제나 사용 권한을 확인하세요.",
        "서비스에 연결할 수 없습니다. 인터넷 연결을 확인하세요.",
        "요청이 너무 많습니다. 잠시 후 다시 시도하세요.",
        "서비스가 응답하지 않습니다. 잠시 후 다시 시도하세요.",
        "이 서비스의 키는 아직 확인할 수 없습니다.",
        "키를 확인하지 못했습니다. 다시 붙여 넣으세요.",
        "키를 저장하지 못했습니다. 다시 시도하세요.",
    ],
    next: "다음",
    connect_first: "먼저 연결하세요",
    connecting: "연결 중…",
    checking: "확인 중…",
    other_title: "어떤 모델을 쓸까요?",
    other_body: "이 컴퓨터의 모델이나 OpenAI 호환 서버를 연결합니다.",
    other_server: "직접 서버 입력",
    local_note: "첫 응답은 조금 느릴 수 있습니다.",
    local_missing: "Ollama나 LM Studio를 켜면 나타납니다",
    rescan: "다시 찾기",
    no_models: "받은 모델이 없습니다",
    custom_title: "OpenAI 호환 서버",
    custom_body: "주소를 넣으면 쓸 수 있는 모델을 찾습니다.",
    custom_url: "서버 주소",
    custom_key: "API 키 (선택)",
    custom_connect: "연결",
};

const EN: Words = Words {
    key_title: |name| format!("Connect {name}"),
    key_label: "API key",
    key_hint: "Checked as soon as you paste it.",
    key_valid: "Connected",
    key_saved: "Saved",
    key_stored: "Your key stays on this computer.",
    get_key: "Get a key",
    key_errors: [
        "This key can't connect. Copy it again and paste it.",
        "This key can't use models. Check billing or access.",
        "Can't reach the service. Check your connection.",
        "Too many tries. Wait a moment, then try again.",
        "The service isn't responding. Try again later.",
        "Butler can't check keys for this service yet.",
        "Couldn't check this key. Paste it again.",
        "Couldn't save the key. Try again.",
    ],
    next: "Next",
    connect_first: "Connect first",
    connecting: "Connecting…",
    checking: "Checking…",
    other_title: "Which model should Butler use?",
    other_body: "A model on this computer or an OpenAI-compatible server.",
    other_server: "Your own server",
    local_note: "The first reply may take a moment.",
    local_missing: "Start Ollama or LM Studio to use it",
    rescan: "Check again",
    no_models: "No models downloaded yet",
    custom_title: "OpenAI-compatible server",
    custom_body: "Enter the address to find its models.",
    custom_url: "Server address",
    custom_key: "API key (optional)",
    custom_connect: "Connect",
};

pub(super) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}
