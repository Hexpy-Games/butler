//! The settings General reads (`SettingsView`, app/types.ts); a missing field takes React's
//! default (`DEFAULT_WEB_SEARCH_SETTINGS`, `?? "auto"`, `?? true`).
use serde::Deserialize;

use crate::ui::source::wire::AccessMode;

#[derive(Default, Deserialize)]
#[serde(default)]
pub(super) struct Slice {
    pub(super) language: String,
    pub(super) timezone: String,
    pub(super) follow_up_behavior: String,
    pub(super) multiline_send_behavior: String,
    pub(super) plan_mode_default: bool,
    pub(super) smart_grouping_enabled: bool,
    pub(super) desktop_tray_enabled: bool,
    pub(super) desktop_notifications: Notifications,
    pub(super) access_mode: Option<AccessMode>,
    pub(super) schedule_access_mode: Option<AccessMode>,
    pub(super) command_sandbox_enabled: Option<bool>,
    pub(super) command_sandbox_available: Option<bool>,
    pub(super) web_search: WebSearch,
}

#[derive(Default, Deserialize)]
#[serde(default)]
pub(super) struct Notifications {
    pub(super) enabled: bool,
    pub(super) assistant_messages: bool,
    pub(super) task_completions: bool,
}

#[derive(Deserialize)]
#[serde(default)]
pub(super) struct WebSearch {
    pub(super) provider: String,
    pub(super) reader_backend: String,
    pub(super) api_key_configured: bool,
    pub(super) api_key_env_var: Option<String>,
    pub(super) planning_enabled: bool,
    pub(super) planning_default_depth: String,
}

impl Default for WebSearch {
    fn default() -> Self {
        Self {
            provider: "duckduckgo-html".into(),
            reader_backend: "browser".into(),
            api_key_configured: false,
            api_key_env_var: None,
            planning_enabled: true,
            planning_default_depth: "balanced".into(),
        }
    }
}
