//! The copy of the browser hand-off panel and the browser step stills. Each field names its
//! `packages/butler-i18n` key.
use butler_ds::ui::context::{Ds, Lang};
use gpui::App;

pub(crate) struct BrowserHandoff {
    /// interfaceTemplates.approvalRequest.signInHandoff: eyebrow, title, onDesktop, stop
    pub(crate) eyebrow: &'static str,
    pub(crate) sign_in_title: &'static str,
    pub(crate) on_desktop: &'static str,
    pub(crate) stop: &'static str,
    /// interfaceTemplates.approvalRequest.payHandoff
    pub(crate) pay_title: &'static str,
    /// browser.still, stillPending, stillUnavailable
    pub(crate) still: &'static str,
    pub(crate) still_pending: &'static str,
    pub(crate) still_unavailable: &'static str,
    /// interfaceFeedback.stewardStopFailed
    pub(crate) steward_stop_failed: &'static str,
    /// shell: the stop request failed (`stop_failed`)
    pub(crate) stop_failed: &'static str,
}

const KO: BrowserHandoff = BrowserHandoff {
    eyebrow: "브라우저",
    sign_in_title: "로그인 확인 필요",
    on_desktop: "PC의 버틀러에서 확인해 주세요",
    stop: "작업 중지",
    pay_title: "결제 확인 필요",
    still: "브라우저 단계",
    still_pending: "이미지 저장 중",
    still_unavailable: "이미지 없음",
    steward_stop_failed: "하위 작업 중지 실패",
    stop_failed: "중지하지 못했습니다",
};

const EN: BrowserHandoff = BrowserHandoff {
    eyebrow: "Browser",
    sign_in_title: "Sign-in needs you",
    on_desktop: "Finish this on your computer",
    stop: "Stop task",
    pay_title: "Payment needs you",
    still: "Browser step",
    still_pending: "Saving image",
    still_unavailable: "Image unavailable",
    steward_stop_failed: "Subtask stop failed",
    stop_failed: "Couldn't stop",
};

impl BrowserHandoff {
    /// The copy of `lang`.
    pub(crate) fn of(lang: Lang) -> &'static Self {
        match lang {
            Lang::Ko => &KO,
            Lang::En => &EN,
        }
    }

    /// The copy of the app language.
    pub(crate) fn get(cx: &App) -> &'static Self {
        Self::of(Ds::get(cx).lang())
    }

    /// interfaceTemplates.approvalRequest.signInStep
    pub(crate) fn sign_in_step(lang: Lang, reason: &str) -> &'static str {
        match (lang, reason) {
            (Lang::Ko, "mfa") => "2단계 인증",
            (Lang::Ko, "passkey") => "패스키",
            (Lang::Ko, "captcha") => "보안 문자",
            (Lang::Ko, "secure_keypad") => "보안 키패드",
            (Lang::Ko, _) => "로그인 양식 확인",
            (Lang::En, "mfa") => "Two-step verification",
            (Lang::En, "passkey") => "Passkey",
            (Lang::En, "captcha") => "CAPTCHA",
            (Lang::En, "secure_keypad") => "Security keypad",
            (Lang::En, _) => "Check sign-in form",
        }
    }

    /// interfaceTemplates.approvalRequest.waitHandoff
    pub(crate) fn wait_handoff(lang: Lang, reason: &str) -> &'static str {
        match (lang, reason) {
            (Lang::Ko, "sign_in") => "로그인 필요",
            (Lang::Ko, "secure_field") => "직접 입력 필요",
            (Lang::Ko, "secure_keypad") => "보안 키패드 입력 필요",
            (Lang::Ko, "captcha") => "보안 문자 입력 필요",
            (Lang::Ko, _) => "직접 확인 필요",
            (Lang::En, "sign_in") => "Sign-in needed",
            (Lang::En, "secure_field") => "Your input needed",
            (Lang::En, "secure_keypad") => "Security keypad needs you",
            (Lang::En, "captcha") => "CAPTCHA needs you",
            (Lang::En, _) => "Needs you in the tab",
        }
    }

    /// interfaceTemplates.approvalRequest.payStep
    pub(crate) fn pay_step(lang: Lang, reason: &str) -> &'static str {
        match (lang, reason) {
            (Lang::Ko, "secure_keypad") => "보안 키패드",
            (Lang::Ko, "app_auth") => "카드사 앱 인증",
            (Lang::Ko, "otp") => "인증번호",
            (Lang::Ko, "three_ds") => "카드사 본인 인증",
            (Lang::Ko, "captcha") => "보안 문자",
            (Lang::Ko, _) => "결제 화면 확인",
            (Lang::En, "secure_keypad") => "Security keypad",
            (Lang::En, "app_auth") => "Card app approval",
            (Lang::En, "otp") => "Verification code",
            (Lang::En, "three_ds") => "Card issuer check",
            (Lang::En, "captcha") => "CAPTCHA",
            (Lang::En, _) => "Check the payment page",
        }
    }

    /// browser.stillFailure; `None` for a reason the catalog does not know.
    pub(crate) fn still_failure(lang: Lang, reason: &str) -> Option<&'static str> {
        Some(match (lang, reason) {
            (Lang::Ko, "dialog_pending") => "대화상자 열림",
            (Lang::Ko, "dispatch_interrupted") => "입력 중단",
            (Lang::Ko, "timeout") => "입력 시간 초과",
            (Lang::Ko, "stills_disabled") => "단계 이미지 꺼짐",
            (Lang::Ko, "document_changed") => "페이지 변경",
            (Lang::Ko, "capture_unavailable") => "캡처 불가",
            (Lang::Ko, "capture_failed") => "캡처 실패",
            (Lang::Ko, "pixels_not_captured") => "캡처되지 않음",
            (Lang::Ko, "file_deleted") => "이미지 삭제됨",
            (Lang::Ko, "control_changed") => "제어권 변경",
            (Lang::Ko, "browser_host_lost") => "브라우저 연결 끊김",
            (Lang::Ko, "gateway_restarted") => "버틀러 재시작",
            (Lang::En, "dialog_pending") => "Dialog open",
            (Lang::En, "dispatch_interrupted") => "Input interrupted",
            (Lang::En, "timeout") => "Input timed out",
            (Lang::En, "stills_disabled") => "Step images off",
            (Lang::En, "document_changed") => "Page changed",
            (Lang::En, "capture_unavailable") => "Capture unavailable",
            (Lang::En, "capture_failed") => "Capture failed",
            (Lang::En, "pixels_not_captured") => "Image not captured",
            (Lang::En, "file_deleted") => "Image removed",
            (Lang::En, "control_changed") => "Control changed",
            (Lang::En, "browser_host_lost") => "Browser disconnected",
            (Lang::En, "gateway_restarted") => "Butler restarted",
            _ => return None,
        })
    }
}
