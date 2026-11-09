//! The copy of the observer dialog. Each field names its `packages/butler-i18n` key.
use butler_ds::ui::context::Lang;

pub(super) struct Words {
    /// inspector.tabs.activity
    pub(super) activity: &'static str,
    /// common.back
    pub(super) back: &'static str,
    /// interfaceStatus.delivered
    pub(super) delivered: &'static str,
    /// interfaceStatus.failedPast
    pub(super) failed: &'static str,
    /// interfaceStatus.cancelled
    pub(super) cancelled: &'static str,
    /// conversation.work.pendingLabel
    pub(super) pending: &'static str,
    /// conversation.work.pendingStateLabels.waiting_for_children
    pub(super) waiting: &'static str,
    /// conversation.work.resumeInterrupted
    pub(super) resume: &'static str,
    /// conversation.work.pendingStateLabels.retrying
    pub(super) retrying: &'static str,
    /// composer.stop
    pub(super) stop: &'static str,
    /// conversation.work.pendingStateLabels.cancelling
    pub(super) cancelling: &'static str,
    /// interfaceFeedback.stewardStopFailed
    pub(super) stop_failed: &'static str,
    /// interfaceFeedback.stewardResumeFailed
    pub(super) resume_failed: &'static str,
}

static KO: Words = Words {
    activity: "활동",
    back: "뒤로가기",
    delivered: "완료됨",
    failed: "실패함",
    cancelled: "중단됨",
    pending: "요청을 처리하고 있습니다.",
    waiting: "작업자 결과를 기다리는 중입니다.",
    resume: "이어서 진행",
    retrying: "다시 시도하고 있습니다.",
    stop: "중지",
    cancelling: "중지하고 있습니다.",
    stop_failed: "하위 작업 중지 실패",
    resume_failed: "하위 작업 재개 실패",
};

static EN: Words = Words {
    activity: "Activity",
    back: "Back",
    delivered: "Completed",
    failed: "Failed",
    cancelled: "Stopped",
    pending: "Working on your request.",
    waiting: "Waiting for Worker results.",
    resume: "Resume",
    retrying: "Retrying.",
    stop: "Stop",
    cancelling: "Stopping.",
    stop_failed: "Subtask stop failed",
    resume_failed: "Subtask resume failed",
};

pub(super) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}
