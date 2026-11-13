//! Copy from Electron vault components and `butler-i18n` butlerVault.
use butler_ds::ui::context::Lang;

pub(crate) struct Words {
    pub(crate) name: &'static str,
    pub(crate) intro: &'static str,
    pub(crate) done: &'static str,
    pub(crate) failed: &'static str,
    pub(crate) skip: &'static str,
    pub(crate) continue_: &'static str,
    pub(crate) decline_title: &'static str,
    pub(crate) decline_note: &'static str,
    pub(crate) decline_confirm: &'static str,
    pub(crate) protected: &'static str,
    pub(crate) off: &'static str,
    pub(crate) turn_on_label: &'static str,
    pub(crate) turn_on: &'static str,
    pub(crate) turned_on: &'static str,
    pub(crate) locked: &'static str,
    pub(crate) stored: &'static str,
    pub(crate) risks: [&'static str; 3],
    pub(crate) kinds: [&'static str; 5],
}

static KO: Words = Words {
    name: "버틀러 금고",
    intro: "비밀번호, 카드, API 키를 암호화한 금고에 모으고, 운영체제의 키체인을 사용해서 안전하게 보관합니다.",
    done: "버틀러 금고 설정이 완료되었습니다. 앞으로 사용자의 정보를 안전하게 보관합니다.",
    failed: "키체인에 등록하지 못했어요. 계속을 눌러 다시 시도하거나 사용 안 함을 고르세요.",
    skip: "사용 안 함",
    continue_: "계속",
    decline_title: "버틀러 금고를 쓰지 않을까요?",
    decline_note: "나중에 설정 → 보안에서 켤 수 있어요.",
    decline_confirm: "사용 안 함",
    protected: "사용자 데이터를 안전하게 보호하고 있어요",
    off: "꺼져 있어요",
    turn_on_label: "버틀러 금고 켜기",
    turn_on: "켜기",
    turned_on: "버틀러 금고를 켰어요",
    locked: "키체인을 열 수 없어 잠겨 있어요",
    stored: "보관 중",
    risks: [
        "비밀번호와 카드가 금고 없이 따로 저장돼요",
        "암호화한 백업을 만들 수 없어요",
        "나중에 다른 기기와 동기화할 수 없어요",
    ],
    kinds: ["API 키", "사이트 로그인", "카드", "내 정보", "플러그인"],
};

static EN: Words = Words {
    name: "Butler Vault",
    intro: "Keeps passwords, cards and API keys together in an encrypted vault, secured with your system's keychain.",
    done: "Butler Vault is set up. Your information is kept safe from now on.",
    failed: "Couldn't add it to the keychain. Press Continue to try again, or choose Don't use.",
    skip: "Don't use",
    continue_: "Continue",
    decline_title: "Don't use Butler Vault?",
    decline_note: "You can turn it on later in Settings → Security.",
    decline_confirm: "Don't use",
    protected: "Your data is protected.",
    off: "Off",
    turn_on_label: "Turn on Butler Vault",
    turn_on: "Turn on",
    turned_on: "Butler Vault is on",
    locked: "Locked: the keychain did not open.",
    stored: "Stored",
    risks: [
        "Passwords and cards are stored separately, without the vault",
        "No encrypted backup",
        "No sync to other devices later",
    ],
    kinds: ["API keys", "Sign-ins", "Cards", "My info", "Plugins"],
};

pub(crate) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}
