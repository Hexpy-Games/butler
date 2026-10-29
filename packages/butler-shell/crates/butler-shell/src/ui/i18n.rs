//! UI copy in Korean and English. Strings that exist in packages/butler-i18n (TypeScript, so
//! not readable at build time) use the same key, named on each field with its catalog path
//! and the same text; `shell.*` fields are new to this app. Product terms follow AGENTS.md.
use crate::ui::source::Risk;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Locale {
    Ko,
    En,
}

impl Locale {
    /// The locale for a BCP 47 tag (the OS's): Korean for `ko*`, English otherwise.
    pub(crate) fn from_tag(tag: &str) -> Self {
        if tag.get(..2).is_some_and(|p| p.eq_ignore_ascii_case("ko")) {
            Self::Ko
        } else {
            Self::En
        }
    }

    pub(crate) fn strings(self) -> &'static Strings {
        match self {
            Self::Ko => &KO,
            Self::En => &EN,
        }
    }
}

pub(crate) struct Strings {
    pub(crate) locale: Locale,
    /// shell.appTitle: the window title (this app is experimental).
    pub(crate) app_title: &'static str,
    /// space.newChat
    pub(crate) new_chat: &'static str,
    /// space.search
    pub(crate) search: &'static str,
    /// space.automations
    pub(crate) schedules: &'static str,
    /// browser.library
    pub(crate) library: &'static str,
    /// space.favorites
    pub(crate) favorites: &'static str,
    /// space.all, space.recent, space.running
    pub(crate) all: &'static str,
    pub(crate) recent: &'static str,
    pub(crate) running: &'static str,
    /// space.space
    pub(crate) space: &'static str,
    /// space.general
    pub(crate) general: &'static str,
    /// sidebar.settings
    pub(crate) settings: &'static str,
    /// conversation.messageActions.showMore
    pub(crate) show_more: &'static str,
    /// composer.placeholder, composer.placeholderFollowUp
    pub(crate) placeholder: &'static str,
    pub(crate) placeholder_follow_up: &'static str,
    /// composer.approval.categoryCommand, composer.approval.categoryEffect
    pub(crate) category_command: &'static str,
    pub(crate) category_effect: &'static str,
    /// composer.approval.allowOnce, composer.approval.deny
    pub(crate) allow_once: &'static str,
    pub(crate) deny: &'static str,
    /// composer.approval.modify, modifyPlaceholder, submitModify, decisionFailed
    pub(crate) modify: &'static str,
    pub(crate) modify_placeholder: &'static str,
    pub(crate) submit_modify: &'static str,
    pub(crate) decision_failed: &'static str,
    /// composer.sendNowFailed
    pub(crate) send_failed: &'static str,
    /// cancel
    pub(crate) cancel: &'static str,
    /// guided.workerStatus.executing, guided.workerStatus.complete
    pub(crate) working: &'static str,
    pub(crate) complete: &'static str,
    /// interfaceTemplates.approvalRequest.risk.{low, medium, high}
    risk: [&'static str; 3],
    /// shell.notRunning: the agent is not attached.
    pub(crate) not_running: &'static str,
    /// shell.notYet: a control this build does not support yet.
    pub(crate) not_yet: &'static str,
    /// shell.answerInApp: an authority request this build cannot decide.
    pub(crate) answer_in_app: &'static str,
    /// shell.loadFailed, shell.stopFailed
    pub(crate) load_failed: &'static str,
    pub(crate) stop_failed: &'static str,
    /// shell.question: a question card's kind label.
    pub(crate) question: &'static str,
}

static KO: Strings = Strings {
    locale: Locale::Ko,
    app_title: "버틀러 (실험)",
    new_chat: "새 대화",
    search: "검색",
    schedules: "예약 작업",
    library: "서랍",
    favorites: "즐겨찾기",
    all: "전체보기",
    recent: "최신",
    running: "진행중",
    space: "스페이스",
    general: "대화",
    settings: "설정",
    show_more: "더보기",
    placeholder: "버틀러에게 무엇이든 물어보세요",
    placeholder_follow_up: "후속 변경사항 요청",
    category_command: "명령",
    category_effect: "작업 승인",
    allow_once: "이번만 허용",
    deny: "거부",
    modify: "수정 또는 다른 방법 제안",
    modify_placeholder: "대신 수행할 방법을 입력하세요",
    submit_modify: "제안 제출",
    decision_failed: "승인 상태를 확인하지 못했습니다. 요청을 계속 표시합니다.",
    send_failed: "보내지 못했습니다",
    cancel: "취소",
    working: "작업 중",
    complete: "완료",
    risk: ["위험 낮음", "위험 보통", "위험 높음"],
    not_running: "버틀러가 실행 중이 아닙니다",
    not_yet: "준비 중",
    answer_in_app: "버틀러 앱에서 답하세요",
    load_failed: "불러오지 못했습니다",
    stop_failed: "중지하지 못했습니다",
    question: "질문",
};

static EN: Strings = Strings {
    locale: Locale::En,
    app_title: "Butler (experimental)",
    new_chat: "New chat",
    search: "Search",
    schedules: "Schedules",
    library: "Library",
    favorites: "Favorites",
    all: "All",
    recent: "Recent",
    running: "Running",
    space: "Space",
    general: "Chats",
    settings: "Settings",
    show_more: "Show more",
    placeholder: "Ask Butler anything",
    placeholder_follow_up: "Ask for follow-up changes",
    category_command: "Command",
    category_effect: "Operation approval",
    allow_once: "Allow once",
    deny: "Deny",
    modify: "Modify or suggest another approach",
    modify_placeholder: "Describe the approach Butler should take instead",
    submit_modify: "Submit suggestion",
    decision_failed: "Could not confirm the approval. The request remains visible.",
    send_failed: "Couldn't send",
    cancel: "Cancel",
    working: "Working",
    complete: "Complete",
    risk: ["Low risk", "Medium risk", "High risk"],
    not_running: "Butler isn't running",
    not_yet: "Coming soon",
    answer_in_app: "Answer in the Butler app",
    load_failed: "Couldn't load",
    stop_failed: "Couldn't stop",
    question: "Question",
};

impl Strings {
    /// shell.controlLabel: effective controls from the agent, in the current locale.
    pub(crate) fn control_label(&self, value: gpui::SharedString) -> gpui::SharedString {
        let pair = match value.as_ref() {
            "ask_first" => ("항상 확인", "Ask first"),
            "ask_except_reads" => ("변경 시 확인", "Ask for changes"),
            "full_access" => ("전체 허용", "Full access"),
            "auto" => ("위험 시 확인", "Ask for risks"),
            "none" => ("없음", "None"),
            "low" => ("낮음", "Low"),
            "medium" => ("보통", "Medium"),
            "high" => ("높음", "High"),
            "xhigh" => ("매우 높음", "Extra high"),
            "max" => ("최대", "Max"),
            _ => return value,
        };
        match self.locale {
            Locale::Ko => pair.0,
            Locale::En => pair.1,
        }
        .into()
    }

    pub(crate) fn risk(&self, risk: Risk) -> &'static str {
        match risk {
            Risk::Low => self.risk[0],
            Risk::Medium => self.risk[1],
            Risk::High => self.risk[2],
        }
    }

    /// interfaceTemplates.activityHistory
    pub(crate) fn activity_history(&self, live: bool, label: &str, count: usize) -> String {
        match self.locale {
            Locale::Ko => format!(
                "{} · {label} · {count}개 기록",
                if live { "현재" } else { "활동" }
            ),
            Locale::En => {
                let records = if count == 1 { "record" } else { "records" };
                format!(
                    "{} · {label} · {count} {records}",
                    if live { "Current" } else { "Activity" }
                )
            }
        }
    }

    /// interfaceTemplates.relativeAge
    pub(crate) fn relative_age(&self, seconds: i64) -> String {
        let (minutes, hours, days) = (seconds / 60, seconds / 3600, seconds / 86_400);
        match (self.locale, seconds) {
            (Locale::Ko, ..60) => "지금".into(),
            (Locale::En, ..60) => "now".into(),
            (Locale::Ko, ..3600) => format!("{minutes}분"),
            (Locale::En, ..3600) => format!("{minutes}m"),
            (Locale::Ko, ..86_400) => format!("{hours}시간"),
            (Locale::En, ..86_400) => format!("{hours}h"),
            (Locale::Ko, _) => format!("{days}일"),
            (Locale::En, _) => format!("{days}d"),
        }
    }
}
