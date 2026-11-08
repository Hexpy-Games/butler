//! The copy of the Start at login field.
use butler_ds::ui::context::Lang;

pub(super) struct LoginCopy {
    /// automations.startAtLogin
    pub(super) label: &'static str,
    /// automations.loginFailed
    pub(super) failed: &'static str,
}

const KO: LoginCopy = LoginCopy {
    label: "로그인 시 시작",
    failed: "로그인 시 시작 변경 실패",
};

const EN: LoginCopy = LoginCopy {
    label: "Start at login",
    failed: "Could not change start at login",
};

pub(super) fn words(lang: Lang) -> &'static LoginCopy {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}
