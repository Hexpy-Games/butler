//! The composer's copy: the toolbar's agent notices, the Git notice, the queue and the controls
//! feedback. Each field names its `packages/butler-i18n` key.
use butler_ds::ui::context::Lang;

pub(crate) mod access;
pub(crate) mod adjunct;
pub(crate) mod attachments;
pub(crate) mod labels;
pub(crate) mod mentions;
pub(crate) mod menus;
pub(crate) mod usage;

pub(crate) struct Words {
    /// feedback.reconnectingShort
    pub(crate) reconnecting: &'static str,
    /// interfaceFeedback.queueFailed
    pub(crate) queue_failed: &'static str,
    /// interfacePanels.controlsFailed
    pub(crate) controls_failed: &'static str,
    /// interfacePanels.modelRefreshFailed
    pub(crate) model_refresh_failed: &'static str,
    /// composer.gitDependency: title, message, action, dismiss
    pub(crate) git_title: &'static str,
    pub(crate) git_message: &'static str,
    pub(crate) git_action: &'static str,
    pub(crate) git_dismiss: &'static str,
}

static KO: Words = Words {
    reconnecting: "실시간 연결 복구 중",
    queue_failed: "메시지 대기열 추가 실패",
    controls_failed: "대화 설정 조회 실패",
    model_refresh_failed: "모델 목록 새로고침 실패",
    git_title: "Git이 설치되어 있지 않습니다",
    git_message: "버틀러는 계속 사용할 수 있지만 브랜치와 커밋 기능은 사용할 수 없습니다.",
    git_action: "Git 설치 안내",
    git_dismiss: "Git 안내 닫기",
};

static EN: Words = Words {
    reconnecting: "Reconnecting to live updates",
    queue_failed: "Message queue failed",
    controls_failed: "Session controls failed",
    model_refresh_failed: "Model catalog refresh failed",
    git_title: "Git is not installed",
    git_message: "Butler still works, but branch and commit features are unavailable.",
    git_action: "Install Git",
    git_dismiss: "Dismiss Git notice",
};

pub(crate) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}
