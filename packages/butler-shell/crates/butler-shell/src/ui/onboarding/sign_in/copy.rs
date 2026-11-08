//! The copy of the ChatGPT sign-in step. Each field names its `packages/butler-i18n` key.
use butler_ds::ui::context::Lang;

pub(super) struct Words {
    /// firstRun.signInTitle
    pub(super) title: fn(&str) -> String,
    /// firstRun.readyTitle
    pub(super) ready_title: fn(&str) -> String,
    /// firstRun.signInPlanOff
    pub(super) plan_off_title: &'static str,
    /// firstRun.signInPlanOffBody
    pub(super) plan_off_body: &'static str,
    /// firstRun.signInBody
    pub(super) body: &'static str,
    /// firstRun.signInAccountMismatch
    pub(super) account_mismatch: &'static str,
    /// firstRun.signInDiscoveryOffline
    pub(super) discovery_offline: &'static str,
    /// firstRun.cancel
    pub(super) cancel: &'static str,
    /// firstRun.next
    pub(super) next: &'static str,
    /// firstRun.connectFirst
    pub(super) connect_first: &'static str,
    /// chatgptPlan.continue
    pub(super) plan_continue: &'static str,
    /// chatgptPlan.otherAccount
    pub(super) other_account: &'static str,
    /// chatgptPlan.turnOn
    pub(super) turn_on: &'static str,
    /// chatgptPlan.signInAgainHint
    pub(super) sign_in_again_hint: &'static str,
    /// chatgptSignIn.pending
    pub(super) pending: &'static str,
    /// chatgptSignIn.open
    pub(super) open: &'static str,
    /// chatgptSignIn.copy
    pub(super) copy: &'static str,
    /// chatgptSignIn.copied
    pub(super) copied: &'static str,
    /// chatgptSignIn.timedOut
    pub(super) timed_out: &'static str,
    /// chatgptSignIn.failed
    pub(super) failed: &'static str,
    /// chatgptSignIn.restart
    pub(super) restart: &'static str,
    /// chatgptSignIn.complete
    pub(super) complete: &'static str,
}

static KO: Words = Words {
    title: |name| format!("{name}에 로그인하세요"),
    ready_title: |name| format!("{name}에 연결했습니다"),
    plan_off_title: "플랜 사용이 꺼져 있습니다",
    plan_off_body: "켜거나 다른 서비스를 고르세요.",
    body: "로그인을 마치면 버틀러가 자동으로 이어갑니다.",
    account_mismatch: "다른 ChatGPT 계정입니다",
    discovery_offline: "ChatGPT에 연결할 수 없습니다. 연결을 확인하세요.",
    cancel: "취소",
    next: "다음",
    connect_first: "먼저 연결하세요",
    plan_continue: "ChatGPT로 계속하기",
    other_account: "다른 계정 사용",
    turn_on: "켜기",
    sign_in_again_hint: "ChatGPT에 다시 로그인하세요",
    pending: "브라우저에서 로그인을 마치세요.",
    open: "브라우저에서 열기",
    copy: "링크 복사",
    copied: "링크를 복사했습니다",
    timed_out: "로그인 시간이 지났습니다",
    failed: "로그인하지 못했습니다",
    restart: "로그인 다시 시작",
    complete: "로그인됨",
};

static EN: Words = Words {
    title: |name| format!("Sign in to {name}"),
    ready_title: |name| format!("Connected to {name}"),
    plan_off_title: "Plan use is off",
    plan_off_body: "Turn it on, or pick another service.",
    body: "Butler picks up automatically when you're done.",
    account_mismatch: "That's a different ChatGPT account",
    discovery_offline: "Can't reach ChatGPT. Check your connection.",
    cancel: "Cancel",
    next: "Next",
    connect_first: "Connect first",
    plan_continue: "Continue with ChatGPT",
    other_account: "Use another account",
    turn_on: "Turn on",
    sign_in_again_hint: "Sign in to ChatGPT again",
    pending: "Finish signing in in your browser.",
    open: "Open in browser",
    copy: "Copy link",
    copied: "Link copied",
    timed_out: "Sign-in timed out",
    failed: "Couldn't sign in",
    restart: "Start sign-in again",
    complete: "Signed in",
};

pub(super) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}
