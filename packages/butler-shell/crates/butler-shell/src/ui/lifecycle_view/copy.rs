//! The copy of the boot, quit and Agent-notice screens. Boot and quit come from
//! `lifecycle-assets/copy.json`; the notice from `packages/butler-i18n` `feedback.*`.
use butler_ds::ui::context::Lang;

pub(super) struct Words {
    /// copy.json startup.title
    pub(super) starting: &'static str,
    /// copy.json startup.stage.service
    pub(super) starting_stage: &'static str,
    /// copy.json startup.failed
    pub(super) failed: &'static str,
    /// copy.json startup.reason.service
    pub(super) failed_reason: &'static str,
    /// copy.json quit.title
    pub(super) quitting: &'static str,
    /// copy.json slow
    pub(super) slow: &'static str,
    /// copy.json action.retry
    pub(super) retry: &'static str,
    /// copy.json action.openLog
    pub(super) open_log: &'static str,
    /// feedback.agentStopped
    pub(super) agent_stopped: &'static str,
    /// feedback.agentRestarting
    pub(super) agent_restarting: &'static str,
    /// feedback.agentRestartFailed
    pub(super) agent_restart_failed: &'static str,
    /// feedback.agentStart
    pub(super) agent_start: &'static str,
    /// feedback.retry
    pub(super) notice_retry: &'static str,
    /// feedback.agentStartFailed
    pub(super) agent_start_failed: &'static str,
}

const KO: Words = Words {
    starting: "버틀러 시작 중…",
    starting_stage: "백그라운드 서비스를 시작하는 중…",
    failed: "버틀러를 시작하지 못했습니다",
    failed_reason: "백그라운드 서비스가 응답하지 않습니다.",
    quitting: "버틀러 종료 중…",
    slow: "평소보다 오래 걸리고 있습니다.",
    retry: "다시 시도",
    open_log: "로그 열기",
    agent_stopped: "에이전트 중지됨",
    agent_restarting: "재시작 중",
    agent_restart_failed: "에이전트 재시작 실패",
    agent_start: "시작",
    notice_retry: "다시 시도",
    agent_start_failed: "에이전트를 시작하지 못했습니다.",
};

const EN: Words = Words {
    starting: "Starting Butler…",
    starting_stage: "Starting the background service…",
    failed: "Butler couldn't start",
    failed_reason: "The background service didn't respond.",
    quitting: "Quitting Butler…",
    slow: "Taking longer than usual.",
    retry: "Try again",
    open_log: "Open log",
    agent_stopped: "Agent stopped",
    agent_restarting: "Restarting",
    agent_restart_failed: "Agent restart failed",
    agent_start: "Start",
    notice_retry: "Try again",
    agent_start_failed: "Could not start the agent.",
};

pub(super) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}
