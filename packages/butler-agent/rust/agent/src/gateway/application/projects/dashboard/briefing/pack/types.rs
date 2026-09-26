//! Typed source facts and ordered revision inputs for project signposts.

use super::super::super::contracts::AppProjectDashboardSnapshot;
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::gateway::application::projects::dashboard::briefing) struct Source {
    pub source_id: String,
    pub kind: String,
    pub id: String,
    pub revision: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) session_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::gateway::application::projects::dashboard::briefing) struct Candidate {
    pub id: String,
    pub source_id: String,
    pub text: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Coverage {
    pub total_works: usize,
    pub included_works: usize,
    pub included_documents: usize,
    pub included_reports: usize,
    pub excluded_units: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FollowupReference {
    pub(super) revision: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) topic: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Followup {
    pub(super) message_id: String,
    pub(super) reported_at: String,
    pub(super) observation: String,
    pub(super) excerpt_truncated: bool,
    pub(super) references: Vec<FollowupReference>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WorkFact {
    pub(super) source_id: String,
    pub(super) title: String,
    pub(super) status: String,
    pub(super) reported_at: String,
    pub(super) objective: String,
    pub(super) summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) linked_user_followups: Option<Vec<Followup>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DocumentFact {
    pub(super) source_id: String,
    pub(super) title: String,
    pub(super) kind: String,
    pub(super) status: String,
    pub(super) parent_id: Option<String>,
    pub(super) reported_at: String,
    pub(super) metadata_only: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) linked_user_followups: Option<Vec<Followup>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ReportFact {
    pub(super) source_id: String,
    pub(super) relation: &'static str,
    pub(super) reported_at: String,
    pub(super) excerpt: String,
    pub(super) excerpt_truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) linked_user_followups: Option<Vec<Followup>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(untagged)]
pub(super) enum Fact {
    Work(WorkFact),
    Document(DocumentFact),
    Report(ReportFact),
}

#[derive(Clone, Debug, Serialize)]
pub(in crate::gateway::application::projects::dashboard::briefing) struct Pack {
    #[serde(rename = "projectId")]
    pub project_id: String,
    pub binding: Option<String>,
    pub language: String,
    pub model: String,
    pub description: String,
    pub(super) facts: Vec<Fact>,
    pub sources: Vec<Source>,
    pub candidates: Vec<Candidate>,
    pub(super) coverage: Coverage,
    #[serde(skip)]
    pub revision: String,
    #[serde(skip)]
    pub reasoning_effort: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct HashInput<'a> {
    pub(super) project_id: &'a str,
    pub(super) binding: &'a Option<String>,
    pub(super) language: &'a str,
    pub(super) model: &'a str,
    pub(super) description: &'a str,
    pub(super) facts: &'a [Fact],
    pub(super) sources: &'a [Source],
    pub(super) candidates: &'a [Candidate],
    pub(super) coverage: &'a Coverage,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) ledger_revision: Option<&'a str>,
    pub(super) reasoning_effort: &'a str,
    pub(super) generator: &'static str,
}

#[derive(Serialize)]
pub(super) struct PromptEnvelope<'a> {
    pub(super) description: &'a str,
    pub(super) facts: &'a [Fact],
    pub(super) sources: &'a [Source],
    pub(super) candidates: &'a [Candidate],
    pub(super) coverage: &'a Coverage,
}

pub(super) struct Unit {
    pub(super) source: Source,
    pub(super) fact: Fact,
    pub(super) proposals: Vec<String>,
    pub(super) ceiling: f64,
    pub(super) category: Category,
}

#[derive(Clone, Copy)]
pub(super) enum Category {
    Work,
    Document,
    Report,
}

pub(in crate::gateway::application::projects::dashboard::briefing) struct PackInput {
    pub project_id: String,
    pub binding: Option<String>,
    pub description: Option<String>,
    pub model: String,
    pub reasoning_effort: String,
    pub context_tokens: u64,
    pub language: String,
    pub snapshot: Option<AppProjectDashboardSnapshot>,
}
