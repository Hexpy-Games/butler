//! UI copy in Korean and English. Strings that exist in packages/butler-i18n (TypeScript, so
//! not readable at build time) use the same key, named on each field with its catalog path
//! and the same text; `shell.*` fields are new to this app. Product terms follow AGENTS.md.
pub(crate) mod artifact_viewer;
pub(crate) mod authority;
pub(crate) mod browser_handoff;
pub(crate) mod canon_order;
pub(crate) mod canon_proposal;
pub(crate) mod composer;
pub(crate) mod file_viewer;
pub(crate) mod initiated;
pub(crate) mod inspector_artifacts;
pub(crate) mod media;
mod messages;
pub(crate) mod new_chat;
pub(crate) mod palette;
pub(crate) mod plan_decision;
pub(crate) mod question;
pub(crate) mod session_info;
pub(crate) mod session_sections;
pub(crate) mod settings;
pub(crate) mod task_graph;

pub(crate) use messages::{AssistantStrings, assistant, transcript, worked_duration};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Locale {
    Ko,
    En,
}

impl Locale {
    /// The locale for a BCP 47 tag (the OS's, React's fallback until the app's language setting
    /// is known): Korean for `ko*`, English otherwise.
    pub(crate) fn from_tag(tag: &str) -> Self {
        if tag.get(..2).is_some_and(|p| p.eq_ignore_ascii_case("ko")) {
            Self::Ko
        } else {
            Self::En
        }
    }

    /// The locale for the app's language setting (`appLocaleFromLanguage`): Korean for "ko",
    /// "ko-KR" or a name containing "korean" or "한국", English otherwise.
    pub(crate) fn from_language(language: &str) -> Self {
        let language = language.trim().to_lowercase();
        if matches!(language.as_str(), "ko" | "ko-kr")
            || language.contains("korean")
            || language.contains("한국")
        {
            Self::Ko
        } else {
            Self::En
        }
    }

    /// The design system's language for this locale.
    pub(crate) fn ds_lang(self) -> butler_ds::ui::context::Lang {
        match self {
            Self::Ko => butler_ds::ui::context::Lang::Ko,
            Self::En => butler_ds::ui::context::Lang::En,
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
    /// common.more
    pub(crate) show_more: &'static str,
    /// composer.placeholder
    pub(crate) placeholder: &'static str,
    /// composer.messageComposer
    pub(crate) message_composer: &'static str,
    /// composer.sendNowFailed
    pub(crate) send_failed: &'static str,
    /// cancel
    pub(crate) cancel: &'static str,
    /// shell.notRunning: the agent is not attached.
    pub(crate) update_required: &'static str,
    pub(crate) not_running: &'static str,
    /// shell.notYet: a control this build does not support yet.
    pub(crate) not_yet: &'static str,
    /// shell.loadFailed, shell.stopFailed
    pub(crate) load_failed: &'static str,
    pub(crate) stop_failed: &'static str,
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
    message_composer: "메시지 입력",
    send_failed: "보내지 못했습니다",
    cancel: "취소",
    update_required: "버틀러 업데이트 필요",
    not_running: "버틀러가 실행 중이 아닙니다",
    not_yet: "준비 중",
    load_failed: "불러오지 못했습니다",
    stop_failed: "중지하지 못했습니다",
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
    show_more: "More",
    placeholder: "Ask Butler anything",
    message_composer: "Message composer",
    send_failed: "Couldn't send",
    cancel: "Cancel",
    update_required: "Update Butler",
    not_running: "Butler isn't running",
    not_yet: "Coming soon",
    load_failed: "Couldn't load",
    stop_failed: "Couldn't stop",
};

impl Strings {
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

    // --- activity (chat/activity) ---

    /// conversation.work.collapse
    pub(crate) fn activity_collapse(&self) -> &'static str {
        match self.locale {
            Locale::Ko => "접기",
            Locale::En => "Collapse",
        }
    }

    /// The labels before a phase's summary, intent and next step (TurnActivityBlock).
    pub(crate) fn activity_detail_labels(&self) -> [&'static str; 3] {
        match self.locale {
            Locale::Ko => ["내용:", "의도:", "다음:"],
            Locale::En => ["Content:", "Intent:", "Next:"],
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
