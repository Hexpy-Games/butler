//! The persisted turn command (`btcc_inbound_inbox.command_json`) and the
//! admitted model route (`btcc_turns.route_state_json`).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::btcc::{AdmittedModelSelection, ProgressDestination, ReasoningEffort};

/// A turn command. Field order is the persisted form, which is also hashed
/// into the admission identity.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TurnCommand {
    /// Admits a user message.
    Run(RunCommand),
    /// Admits an authorized wake.
    Wake(WakeCommand),
    /// Resumes an admitted turn.
    Resume(ResumeCommand),
}

/// Resumes the admitted turn `turn_id`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeCommand {
    pub turn_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovery_attempt: Option<u32>,
}

/// Admits a turn for a user message.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCommand {
    pub turn_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovery_attempt: Option<u32>,
    pub session_id: String,
    pub trigger_key: String,
    pub message: CommandMessage,
    pub model_selection: CommandModelSelection,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress_destination: Option<ProgressDestination>,
    /// The assembled context document, persisted verbatim as
    /// `btcc_turns.context_json`; typed readers use `ButlerContext`.
    // Passthrough: context document assembled by the context assembler, persisted verbatim; typed reads use ButlerContext.
    pub context: Value,
}

/// Admits a turn for an authorized wake.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeCommand {
    pub turn_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovery_attempt: Option<u32>,
    pub session_id: String,
    pub trigger_key: String,
    pub trigger: CommandTrigger,
    pub model_selection: CommandModelSelection,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress_destination: Option<ProgressDestination>,
    /// The assembled context document, persisted verbatim as
    /// `btcc_turns.context_json`; typed readers use `ButlerContext`.
    // Passthrough: context document assembled by the context assembler, persisted verbatim; typed reads use ButlerContext.
    pub context: Value,
}

/// The user message a run admits.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandMessage {
    pub message_id: String,
    pub content: String,
}

/// The authorized trigger a wake admits.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandTrigger {
    pub trigger_id: String,
    pub source_turn_id: String,
    pub authorization_ref: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_scope_ref: Option<String>,
    pub content: String,
}

/// The admitted model selection with its route; the route is stored apart
/// from the selection (`route_state_json` vs `model_selection_json`).
/// Admission always routes; a command without a route admits an unrouted turn.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandModelSelection {
    #[serde(flatten)]
    pub selection: AdmittedModelSelection,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_route: Option<RouteState>,
}

/// The route fields `route_digest` is computed over.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteIdentity<'a> {
    pub schema_version: &'a str,
    pub candidates: &'a [RouteCandidate],
    pub retry_ceiling: u32,
    pub catalog_generation: &'a str,
}

/// The model route state (`btcc_turns.route_state_json`), as admitted and as
/// the route runtime advances it. Field order is the admitted form; the first
/// four fields (see [`RouteIdentity`]) are hashed into `route_digest`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteState {
    pub schema_version: String,
    pub candidates: Vec<RouteCandidate>,
    pub retry_ceiling: u32,
    pub catalog_generation: String,
    pub route_digest: String,
    pub active_cursor: u32,
    #[serde(default)]
    pub consumed_attempts: Vec<String>,
}

/// One model the route may run.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteCandidate {
    pub model_ref: String,
    pub reasoning_effort: ReasoningEffort,
}

impl TurnCommand {
    /// The turn the command admits or resumes.
    pub fn turn_id(&self) -> &str {
        match self {
            Self::Run(command) => &command.turn_id,
            Self::Wake(command) => &command.turn_id,
            Self::Resume(command) => &command.turn_id,
        }
    }
}

#[cfg(any(test, feature = "test-support"))]
impl TurnCommand {
    /// A run command for fixtures, with a minimal unrouted model selection.
    // Passthrough: test-support fixture helper over command JSON.
    pub fn fixture_run(
        turn_id: &str,
        session_id: &str,
        trigger_key: &str,
        message: CommandMessage,
        // Passthrough: context document assembled by the context assembler, persisted verbatim; typed reads use ButlerContext.
        context: Value,
    ) -> Self {
        Self::Run(RunCommand {
            turn_id: turn_id.into(),
            recovery_attempt: None,
            session_id: session_id.into(),
            trigger_key: trigger_key.into(),
            message,
            model_selection: CommandModelSelection::fixture(),
            progress_destination: None,
            context,
        })
    }

    /// Edits the command through its JSON form (fixtures).
    ///
    /// # Panics
    /// When the edited JSON is no longer a command.
    #[allow(clippy::missing_panics_doc)]
    // Passthrough: test-support fixture helper over command JSON.
    pub fn edit_json(&mut self, edit: impl FnOnce(&mut Value)) {
        let mut value = serde_json::to_value(&*self).expect("command encodes");
        edit(&mut value);
        *self = serde_json::from_value(value).expect("edited command decodes");
    }
}

#[cfg(any(test, feature = "test-support"))]
impl CommandModelSelection {
    /// An unrouted `openai/gpt` selection for fixtures.
    pub fn fixture() -> Self {
        Self {
            selection: AdmittedModelSelection {
                provider: "openai".into(),
                model: "gpt".into(),
                reasoning_effort: ReasoningEffort::Medium,
                controls: serde_json::Map::new(),
                controls_hash: String::new(),
                context_window_tokens: Some(100.0),
                extensions: serde_json::Map::new(),
            },
            model_route: None,
        }
    }
}
