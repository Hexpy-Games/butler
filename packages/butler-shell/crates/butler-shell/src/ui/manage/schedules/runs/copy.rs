//! The run list copy. Each field names its `packages/butler-i18n` key.
use butler_ds::ui::context::Lang;

pub(super) struct Words {
    /// automations.fields.runs
    pub(super) title: &'static str,
    /// automations.runs.empty
    pub(super) empty: &'static str,
    /// automations.runs.queued
    pub(super) queued: &'static str,
    /// automations.runs.succeeded
    pub(super) succeeded: &'static str,
    /// automations.runs.failed
    pub(super) failed: &'static str,
    /// automations.runs.running
    pub(super) running: &'static str,
    /// automations.runs.skippedTargetUnavailable
    pub(super) skipped_target_unavailable: &'static str,
    /// automations.runs.signinOff
    pub(super) signin_off: &'static str,
    /// automations.runs.paymentOff
    pub(super) payment_off: &'static str,
    /// automations.runs.needsPermission
    pub(super) needs_permission: &'static str,
    /// automations.runs.cancelled
    pub(super) cancelled: &'static str,
    /// automations.runs.notRun
    pub(super) not_run: &'static str,
}

static KO: Words = Words {
    title: "실행 기록",
    empty: "아직 실행 기록이 없습니다",
    queued: "대기 중",
    succeeded: "성공",
    failed: "실패",
    running: "실행 중",
    skipped_target_unavailable: "대상을 사용할 수 없음",
    signin_off: "로그인 정보 꺼짐",
    payment_off: "결제 정보 꺼짐",
    needs_permission: "권한 필요",
    cancelled: "취소됨",
    not_run: "실행 전",
};

static EN: Words = Words {
    title: "Runs",
    empty: "No runs yet",
    queued: "Queued",
    succeeded: "Succeeded",
    failed: "Failed",
    running: "Running",
    skipped_target_unavailable: "Target unavailable",
    signin_off: "Sign-in info off",
    payment_off: "Payment info off",
    needs_permission: "Needs permission",
    cancelled: "Cancelled",
    not_run: "Not run yet",
};

pub(super) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}
