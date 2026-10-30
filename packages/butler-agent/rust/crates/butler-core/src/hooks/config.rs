//! Phase-one configuration; unsupported transports/scopes are rejected.
use super::HookEvent;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
/// One user-scope configuration file.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HookConfig {
    /// Schema major, currently 1.
    pub version: u32,
    /// File order is execution/decision order.
    pub hooks: Vec<HookDefinition>,
}
/// Exact names or trailing-star tool prefixes.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HookMatcher {
    /// Tool matchers; empty matches every tool.
    pub tools: Vec<String>,
}
/// User-authored command, never an approval grant.
#[derive(Clone, Debug, Serialize)]
#[serde(deny_unknown_fields)]
pub struct HookDefinition {
    /// Unique id within the user file.
    pub id: String,
    /// Optional display name.
    pub name: Option<String>,
    /// Event to receive.
    pub event: HookEvent,
    /// Tool filter, only for tool events.
    #[serde(default, rename = "match")]
    pub matcher: HookMatcher,
    /// Only command is supported in phase one.
    #[serde(rename = "type")]
    pub kind: String,
    /// Shell command; mutually exclusive with args.
    pub command: Option<String>,
    /// Executable and literal argv; no shell.
    pub args: Option<Vec<String>>,
    /// Literal environment additions.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// Timeout in milliseconds (default 30 seconds).
    #[serde(default)]
    pub timeout_ms: u64,
    /// Observe-only background execution.
    #[serde(default, rename = "async")]
    pub asynchronous: bool,
    /// Errors block pre-events only when explicitly enabled.
    #[serde(default, rename = "failClosed")]
    pub fail_closed: bool,
    /// Enabled by default for user-authored entries.
    #[serde(default = "yes")]
    pub enabled: bool,
    /// Accepted schema major (default 1).
    #[serde(default = "one")]
    pub schema_version: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct HookDefinitionInput {
    /// Unique id within the user file.
    id: String,
    /// Optional display name.
    name: Option<String>,
    /// Event to receive.
    event: HookEvent,
    /// Tool filter, only for tool events.
    #[serde(default, rename = "match")]
    matcher: HookMatcher,
    /// Only command is supported in phase one.
    #[serde(rename = "type")]
    kind: String,
    /// Shell command; mutually exclusive with args.
    command: Option<String>,
    /// Executable and literal argv; no shell.
    args: Option<Vec<String>>,
    /// Literal environment additions.
    #[serde(default)]
    env: BTreeMap<String, String>,
    /// Timeout in milliseconds (default 30 seconds).
    #[serde(default)]
    timeout_ms: Option<u64>,
    /// Observe-only background execution.
    #[serde(default, rename = "async")]
    asynchronous: bool,
    /// Errors block pre-events only when explicitly enabled.
    #[serde(default, rename = "failClosed")]
    fail_closed: bool,
    /// Enabled by default for user-authored entries.
    #[serde(default = "yes")]
    enabled: bool,
    /// Accepted schema major (default 1).
    #[serde(default = "one")]
    schema_version: u32,
}
fn yes() -> bool {
    true
}
fn one() -> u32 {
    1
}
impl HookDefinition {
    /// Match one tool without regex or content predicates.
    pub fn matches(&self, tool: Option<&str>) -> bool {
        self.enabled
            && (self.matcher.tools.is_empty()
                || tool.is_some_and(|tool| {
                    self.matcher.tools.iter().any(|pattern| {
                        pattern
                            .strip_suffix('*')
                            .map_or(pattern == tool, |prefix| tool.starts_with(prefix))
                    })
                }))
    }
    /// Name for safe diagnostics.
    pub fn label(&self) -> &str {
        self.name
            .as_deref()
            .filter(|name| !name.trim().is_empty())
            .unwrap_or(&self.id)
    }
}
impl HookConfig {
    /// Enforce phase-one limits before publishing any registry.
    pub fn validate(&self) -> Result<(), String> {
        if self.version != 1 || self.hooks.len() > 64 {
            return Err("Expected version 1 and at most 64 hooks".into());
        }
        let mut ids = HashSet::new();
        for hook in &self.hooks {
            if hook.id.is_empty()
                || hook.id.len() > 128
                || !ids.insert(&hook.id)
                || !hook
                    .id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
            {
                return Err("Hook ids must be unique letters, numbers, '-' or '_'".into());
            }
            if hook.kind != "command" || hook.schema_version != 1 {
                return Err("Only command hooks accepting schema 1 are supported".into());
            }
            let command = hook.command.as_ref().is_some_and(|v| !v.trim().is_empty());
            let args = hook
                .args
                .as_ref()
                .is_some_and(|v| v.first().is_some_and(|s| !s.is_empty()));
            if command == args || (hook.command.is_some() && hook.args.is_some()) {
                return Err("Choose command or executable args".into());
            }
            let cap = if hook.asynchronous { 600_000 } else { 120_000 };
            if hook.timeout_ms == 0
                || hook.timeout_ms > cap
                || (hook.asynchronous && hook.event.blocks())
            {
                return Err("Invalid timeout or async pre-event".into());
            }
            if !hook.matcher.tools.is_empty() && !hook.event.tool_event() {
                return Err("Tool matchers require a tool event".into());
            }
            if hook
                .matcher
                .tools
                .iter()
                .any(|s| s.is_empty() || s.trim_end_matches('*').contains('*') || s.ends_with("**"))
            {
                return Err("Tool matchers use exact names or one trailing '*'".into());
            }
            if hook.env.keys().any(|s| {
                s.is_empty()
                    || s.contains('=')
                    || s.contains('\0')
                    || s.eq_ignore_ascii_case("BUTLER_DATA")
            }) {
                return Err("Invalid hook environment".into());
            }
            if self.hooks.iter().filter(|h| h.event == hook.event).count() > 16 {
                return Err("At most 16 hooks per event".into());
            }
        }
        Ok(())
    }
}

impl<'de> Deserialize<'de> for HookDefinition {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let input = HookDefinitionInput::deserialize(deserializer)?;
        Ok(Self {
            id: input.id,
            name: input.name,
            event: input.event,
            matcher: input.matcher,
            kind: input.kind,
            command: input.command,
            args: input.args,
            env: input.env,
            timeout_ms: input.timeout_ms.unwrap_or(if input.asynchronous {
                60_000
            } else {
                30_000
            }),
            asynchronous: input.asynchronous,
            fail_closed: input.fail_closed,
            enabled: input.enabled,
            schema_version: input.schema_version,
        })
    }
}
