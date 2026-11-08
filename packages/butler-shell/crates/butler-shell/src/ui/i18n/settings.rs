//! The settings frame's copy (`appCopy.settings` frame keys and `common.confirm`/`cancel`). Each
//! field names its `packages/butler-i18n` key. The per-section table is in [`sections`];
//! `sectionsLabel` and `searchLabel` are ARIA labels, which gpui has no slot for.
use butler_ds::ui::context::Lang;

mod sections;

pub(crate) use sections::{Localized, SETTINGS_SECTIONS, memory_assigned};

pub(crate) struct Words {
    /// settings.title
    pub(crate) title: &'static str,
    /// settings.back
    pub(crate) back: &'static str,
    /// settings.saving
    pub(crate) saving: &'static str,
    /// settings.saved
    pub(crate) saved: &'static str,
    /// settings.searchPlaceholder
    pub(crate) search_placeholder: &'static str,
    /// settings.groups.preferences
    pub(crate) group_preferences: &'static str,
    /// settings.groups.appAndSystem
    pub(crate) group_app_and_system: &'static str,
    /// settings.groups.advanced
    pub(crate) group_advanced: &'static str,
    /// settings.sectionState.loading
    pub(crate) state_loading: &'static str,
    /// settings.sectionState.error
    pub(crate) state_error: &'static str,
    /// settings.sectionState.retry
    pub(crate) state_retry: &'static str,
    /// settings.sectionState.empty
    pub(crate) state_empty: &'static str,
    /// settings.errors.saveFailed
    pub(crate) save_failed: &'static str,
    /// settings.descriptions.reasoningFixed (`ReasoningSelect`)
    pub(crate) reasoning_fixed: &'static str,
    /// common.confirm
    pub(crate) confirm: &'static str,
    /// common.cancel
    pub(crate) cancel: &'static str,
}

static KO: Words = Words {
    title: "설정",
    back: "돌아가기",
    saving: "저장 중",
    saved: "저장됨",
    search_placeholder: "설정 검색",
    group_preferences: "환경 설정",
    group_app_and_system: "앱 및 시스템",
    group_advanced: "고급",
    state_loading: "불러오는 중",
    state_error: "이 섹션을 불러오지 못했습니다.",
    state_retry: "다시 시도",
    state_empty: "아직 표시할 항목이 없습니다.",
    save_failed: "저장하지 못했습니다.",
    reasoning_fixed: "모델이 정해요",
    confirm: "확인",
    cancel: "취소",
};

static EN: Words = Words {
    title: "Settings",
    back: "Back",
    saving: "Saving",
    saved: "Saved",
    search_placeholder: "Search settings",
    group_preferences: "Preferences",
    group_app_and_system: "App and system",
    group_advanced: "Advanced",
    state_loading: "Loading",
    state_error: "Could not load this section.",
    state_retry: "Retry",
    state_empty: "Nothing to show yet.",
    save_failed: "Couldn't save.",
    reasoning_fixed: "Set by the model",
    confirm: "Confirm",
    cancel: "Cancel",
};

pub(crate) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}

/// settings.searchEmpty
pub(crate) fn search_empty(lang: Lang, query: &str) -> String {
    match lang {
        Lang::Ko => format!("일치하는 설정이 없습니다: {query}"),
        Lang::En => format!("No settings match: {query}"),
    }
}
