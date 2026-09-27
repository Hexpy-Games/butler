use std::{future::Future, pin::Pin};

use serde::Serialize;
use serde_json::Value;

use crate::profile::RuntimeProfileProjection;
use butler_models::models::ReasoningEffort;

/// Whether and how briefings may be generated.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub enum BriefingSettings {
    /// A briefing model is configured.
    Configured {
        /// Locale of the briefing text.
        locale: String,
        /// Model reference.
        model: String,
        /// Reasoning effort for the briefing request.
        reasoning_effort: ReasoningEffort,
    },
    /// Briefings are off.
    Unavailable {
        /// Locale of the briefing text.
        locale: String,
        /// Why no briefing can be generated.
        reason: &'static str,
    },
}

/// The active persona.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct BriefingPersona {
    /// Persona id.
    pub id: Option<String>,
    /// Persona text applied to the briefing.
    pub text: Option<String>,
}

/// A project's recent activity, as the briefing sees it.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct BriefingProjectSignal {
    /// Project id.
    pub id: String,
    /// Project name.
    pub display_name: String,
    /// Short project summary.
    pub summary: Option<String>,
    /// Titles of recent sessions in the project.
    pub recent_session_titles: Vec<String>,
    /// Summary of recent ledger events.
    pub ledger_event_summary: Vec<String>,
    /// Titles of open work items.
    pub open_work_titles: Vec<String>,
    /// Titles of recently completed work items.
    pub completed_work_titles: Vec<String>,
    /// Topics the briefing must not suggest.
    pub excluded_topics: Vec<String>,
}

/// Everything a briefing run is generated from.
#[derive(Clone, Debug, PartialEq)]
pub struct BriefingInputSnapshot {
    /// Briefing settings.
    pub settings: BriefingSettings,
    /// Active persona.
    pub persona: BriefingPersona,
    /// Runtime profile projection, when profiling is on.
    pub projection: Option<RuntimeProfileProjection>,
    /// Projects with recent activity.
    pub projects: Vec<BriefingProjectSignal>,
}

/// The pending result of a briefing input snapshot.
pub type BriefingInputFuture<'a> = Pin<
    Box<dyn Future<Output = Result<BriefingInputSnapshot, BriefingGenerationError>> + Send + 'a>,
>;

/// Supplies briefing inputs and local time.
pub trait BriefingInputSource: Send + Sync {
    /// The current briefing inputs.
    fn snapshot(&self) -> BriefingInputFuture<'_>;
    /// Minute of the local day for `epoch_ms`.
    fn local_minute(&self, epoch_ms: i64) -> Result<u16, BriefingGenerationError>;
}

pub use super::error::{BriefingGenerationCode, BriefingGenerationError};

pub(super) fn error(
    code: BriefingGenerationCode,
    message: impl Into<String>,
) -> BriefingGenerationError {
    BriefingGenerationError::new(code, message)
}

pub(super) fn prepared_fingerprint(
    snapshot: &BriefingInputSnapshot,
    project_id: Option<&str>,
) -> Value {
    let project =
        project_id.and_then(|id| snapshot.projects.iter().find(|project| project.id == id));
    serde_json::json!({
        "settings": snapshot.settings,
        "persona": snapshot.persona,
        "projection": snapshot.projection,
        "project": project,
    })
}
