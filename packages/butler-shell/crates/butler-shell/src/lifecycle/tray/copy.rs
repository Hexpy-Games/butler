//! The tray's words. Electron writes them as English literals in `main.mjs:1490-1620` and
//! `tray-agent-menu.mjs` (no butler-i18n key); "Start at login" is `desktop-copy.mjs`
//! `startAtLogin`. The Korean is this port's translation.
use crate::ui::i18n::Locale;

pub(super) struct Words {
    /// `appDisplayName`, the tooltip.
    pub(super) tooltip: &'static str,
    /// "Open Butler"
    pub(super) open: &'static str,
    /// "Restart Butler Agent"
    pub(super) restart: &'static str,
    /// desktop-copy `startAtLogin`
    pub(super) login: &'static str,
    /// "New Chat"
    pub(super) new_chat: &'static str,
    /// "Recent Conversations"
    pub(super) recent: &'static str,
    /// "No recent conversations"
    pub(super) none: &'static str,
    /// "Untitled conversation"
    pub(super) untitled: &'static str,
    /// "Quit Butler"
    pub(super) quit: &'static str,
    /// `trayAgentServiceLabel`: "Butler Agent: Running"
    pub(super) running: &'static str,
    /// "Butler Agent: Starting"
    pub(super) starting: &'static str,
    /// "Butler Agent: Not Installed" (the supervisor's `idle` phase)
    pub(super) not_installed: &'static str,
    /// "Butler Agent: Updating"
    pub(super) updating: &'static str,
    /// "Butler Agent: Stopped"
    pub(super) stopped: &'static str,
    /// "Butler Agent: Failed"
    pub(super) failed: &'static str,
}

static KO: Words = Words {
    tooltip: "버틀러",
    open: "버틀러 열기",
    restart: "버틀러 에이전트 다시 시작",
    login: "로그인 시 시작",
    new_chat: "새 대화",
    recent: "최근 대화",
    none: "최근 대화 없음",
    untitled: "제목 없는 대화",
    quit: "버틀러 종료",
    running: "버틀러 에이전트: 실행 중",
    starting: "버틀러 에이전트: 시작 중",
    not_installed: "버틀러 에이전트: 설치되지 않음",
    updating: "버틀러 에이전트: 업데이트 중",
    stopped: "버틀러 에이전트: 중지됨",
    failed: "버틀러 에이전트: 실패",
};

static EN: Words = Words {
    tooltip: "Butler",
    open: "Open Butler",
    restart: "Restart Butler Agent",
    login: "Start at login",
    new_chat: "New Chat",
    recent: "Recent Conversations",
    none: "No recent conversations",
    untitled: "Untitled conversation",
    quit: "Quit Butler",
    running: "Butler Agent: Running",
    starting: "Butler Agent: Starting",
    not_installed: "Butler Agent: Not Installed",
    updating: "Butler Agent: Updating",
    stopped: "Butler Agent: Stopped",
    failed: "Butler Agent: Failed",
};

pub(super) fn words(locale: Locale) -> &'static Words {
    match locale {
        Locale::Ko => &KO,
        Locale::En => &EN,
    }
}
