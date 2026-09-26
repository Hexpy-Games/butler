use std::{future::Future, pin::Pin};

use serde::Serialize;
use serde_json::Value;

use crate::{models::ReasoningEffort, profile::RuntimeProfileProjection};

#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) enum BriefingSettings {
    Configured {
        locale: String,
        model: String,
        reasoning_effort: ReasoningEffort,
    },
    Unavailable {
        locale: String,
        reason: &'static str,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct BriefingPersona {
    pub id: Option<String>,
    pub text: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct BriefingProjectSignal {
    pub id: String,
    pub display_name: String,
    pub summary: Option<String>,
    pub recent_session_titles: Vec<String>,
    pub ledger_event_summary: Vec<String>,
    pub open_work_titles: Vec<String>,
    pub completed_work_titles: Vec<String>,
    pub excluded_topics: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct BriefingInputSnapshot {
    pub settings: BriefingSettings,
    pub persona: BriefingPersona,
    pub projection: Option<RuntimeProfileProjection>,
    pub projects: Vec<BriefingProjectSignal>,
}

pub(crate) type BriefingInputFuture<'a> = Pin<
    Box<dyn Future<Output = Result<BriefingInputSnapshot, BriefingGenerationError>> + Send + 'a>,
>;

pub(crate) trait BriefingInputSource: Send + Sync {
    fn snapshot(&self) -> BriefingInputFuture<'_>;
    fn local_minute(&self, epoch_ms: i64) -> Result<u16, BriefingGenerationError>;
}

#[derive(Clone, Debug)]
pub(crate) struct BriefingGenerationError {
    pub code: &'static str,
    pub message: String,
}

impl BriefingGenerationError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

pub(super) fn error(code: &'static str, message: impl Into<String>) -> BriefingGenerationError {
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
