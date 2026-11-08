//! `hooksTypes.ts`: what `/hooks` and `/hooks/runs` carry.
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub(super) const HOOK_EVENTS: [&str; 6] = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Stop",
    "SubagentStop",
];

#[derive(Clone, Default, Deserialize, Serialize)]
pub(super) struct HookMatch {
    #[serde(default)]
    pub(super) tools: Vec<String>,
}

#[derive(Clone, Deserialize, Serialize)]
pub(super) struct HookDefinition {
    pub(super) id: String,
    #[serde(default)]
    pub(super) name: Option<String>,
    pub(super) event: String,
    #[serde(rename = "match", default)]
    pub(super) matcher: HookMatch,
    #[serde(rename = "type")]
    pub(super) kind: String,
    #[serde(default)]
    pub(super) command: Option<String>,
    #[serde(default)]
    pub(super) args: Option<Vec<String>>,
    #[serde(default)]
    pub(super) env: BTreeMap<String, String>,
    pub(super) timeout_ms: u64,
    #[serde(rename = "async", default)]
    pub(super) background: bool,
    #[serde(rename = "failClosed", default)]
    pub(super) fail_closed: bool,
    #[serde(default)]
    pub(super) enabled: bool,
    #[serde(default)]
    pub(super) schema_version: u32,
}

impl HookDefinition {
    /// `emptyHook`
    pub(super) fn empty() -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name: Some(String::new()),
            event: "PreToolUse".into(),
            matcher: HookMatch::default(),
            kind: "command".into(),
            command: Some(String::new()),
            args: None,
            env: BTreeMap::new(),
            timeout_ms: 30_000,
            background: false,
            fail_closed: false,
            enabled: true,
            schema_version: 1,
        }
    }

    /// The name, else the id.
    pub(super) fn title(&self) -> &str {
        self.name
            .as_deref()
            .filter(|name| !name.is_empty())
            .unwrap_or(&self.id)
    }
}

#[derive(Clone, Default, Deserialize)]
pub(super) struct HookConfig {
    #[serde(default)]
    pub(super) hooks: Vec<HookDefinition>,
}

#[derive(Clone, Deserialize)]
pub(super) struct HookSettings {
    pub(super) revision: Value,
    pub(super) config: HookConfig,
    #[serde(default)]
    pub(super) error: Option<String>,
}

#[derive(Clone, Deserialize)]
pub(super) struct HookRun {
    pub(super) time: String,
    pub(super) hook_id: String,
    pub(super) event: String,
    #[serde(default)]
    pub(super) session_id: Option<String>,
    pub(super) outcome: String,
    #[serde(default)]
    pub(super) reason: Option<String>,
    #[serde(default)]
    pub(super) exit_code: Option<i64>,
    pub(super) duration_ms: f64,
    #[serde(default)]
    pub(super) stdout: String,
    #[serde(default)]
    pub(super) stderr: String,
}

/// `blockingEvent`
pub(super) fn blocking_event(event: &str) -> bool {
    matches!(
        event,
        "UserPromptSubmit" | "PreToolUse" | "Stop" | "SubagentStop"
    )
}
