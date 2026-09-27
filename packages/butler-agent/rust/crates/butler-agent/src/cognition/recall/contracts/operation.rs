//! Source-shaped operation values shared by graph reads and recall orchestration.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RecallScope {
    CurrentSession,
    CurrentProject,
    AllUserSessions,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RecallProjectFilter {
    Any,
    Unassigned,
    Selected,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RecallTimeBasis {
    Conversation,
    Event,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub(crate) struct RecallTime {
    pub from: String,
    pub to: String,
    pub basis: RecallTimeBasis,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecallRuntime {
    pub session_id: String,
    pub turn_id: String,
    pub current_user_message: String,
    pub native_operation_id: String,
    pub project_id: Option<String>,
}

#[expect(
    clippy::struct_excessive_bools,
    reason = "mirrors the serialized result schema field for field"
)]
#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct RecallAdmittedChannels {
    pub graph: bool,
    pub lexical: bool,
    pub vector: bool,
    pub context: bool,
    pub explicit: bool,
    pub task: bool,
}

impl Default for RecallAdmittedChannels {
    fn default() -> Self {
        Self {
            graph: true,
            lexical: true,
            vector: true,
            context: true,
            explicit: true,
            task: true,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecallRequest {
    pub cue: String,
    #[serde(default)]
    pub seed_phrases: Vec<String>,
    #[serde(default)]
    pub vector_queries: Vec<String>,
    pub include_vector: bool,
    pub include_internal: bool,
    pub limit: usize,
    pub scope: RecallScope,
    pub project_filter: RecallProjectFilter,
    pub project_ids: Vec<String>,
    pub session_ids: Vec<String>,
    pub as_of: String,
    #[serde(default)]
    pub as_of_explicit: bool,
    pub time: Option<RecallTime>,
    pub cursor: Option<String>,
    pub admitted_channels: Option<RecallAdmittedChannels>,
    pub runtime: RecallRuntime,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RecallCoverageState {
    Ok,
    Partial,
    Unavailable,
    DisabledByRequest,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct RecallCoverageLane {
    pub state: RecallCoverageState,
    pub candidates: usize,
    pub codes: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct RecallCoverage {
    pub graph: RecallCoverageLane,
    pub vectors: RecallCoverageLane,
    pub source: RecallCoverageLane,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RecallStatus {
    Complete,
    Partial,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RecallSourceKind {
    Conversation,
    TaskReport,
    ExplicitRecord,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RecallEvidenceRelation {
    Mentions,
    Supports,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct RecallEvidenceSupport {
    pub node_ref: String,
    pub relation: RecallEvidenceRelation,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct RecallReadArgs {
    pub scope: RecallScope,
    pub source_ref: String,
    pub max_chars: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_filter: Option<RecallProjectFilter>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_internal: Option<bool>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct RecallEvidence {
    pub source_ref: String,
    pub basis: String,
    pub excerpt: String,
    pub source_resolved: bool,
    pub conversation_session_id: Option<String>,
    pub conversation_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_kind: Option<RecallSourceKind>,
    pub support: RecallEvidenceSupport,
    pub read_args: RecallReadArgs,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct RecallRequirement {
    pub node_ref: String,
    pub action: String,
    pub condition: crate::json::JsonDocument,
    pub basis: String,
    pub source_refs: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum InterpretationStatus {
    Recorded,
    Historical,
    Superseded,
    Conflicted,
    Refined,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct RecallInterpretation {
    pub node_ref: String,
    pub statement: String,
    pub speech_act: String,
    pub basis: String,
    pub source_class: String,
    pub authority: String,
    pub source_refs: Vec<String>,
    pub support_complete: bool,
    pub status: InterpretationStatus,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct RecallResultItem {
    pub episode_ref: String,
    pub revision: String,
    pub summary: String,
    pub occurred_at: Option<String>,
    pub conversation_at: Option<String>,
    pub channels: Vec<String>,
    pub matched_node_ref: Option<String>,
    pub association_path: Vec<super::RecallAssociationStep>,
    pub evidence: Vec<RecallEvidence>,
    pub requirements: Vec<RecallRequirement>,
    pub interpretations: Vec<RecallInterpretation>,
    pub current_state_requires_verification: bool,
    pub qualifications: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct RecallResponse {
    pub status: RecallStatus,
    pub results: Vec<RecallResultItem>,
    pub coverage: RecallCoverage,
    pub next_cursor: Option<String>,
    pub diagnostics: Vec<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct IdentityReadScope {
    pub as_of: String,
    pub scope: RecallScope,
    pub current_session_id: String,
    pub current_project_id: Option<String>,
    pub session_ids: Vec<String>,
    pub project_filter: RecallProjectFilter,
    pub project_ids: Vec<String>,
    pub include_internal: bool,
    pub deadline_at: i64,
}

#[derive(Clone, Debug)]
pub(crate) struct IdentityResolution {
    pub node_id: String,
    pub partial: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct IdentityMembersResult {
    pub members: Vec<String>,
    pub partial: bool,
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct IdentitySourceBinding {
    pub source_ref: String,
    pub episode_id: String,
    pub revision: String,
    pub content_hash: String,
    pub byte_start: i64,
    pub byte_end: i64,
    pub quote: String,
    pub quote_byte_start: i64,
    pub quote_byte_end: i64,
    pub project_id: Option<String>,
    pub session_id: String,
    pub origin_kind: String,
    pub role: String,
    pub observed_at: String,
}

#[derive(Clone, Debug)]
pub(crate) struct RecallVectorMatch {
    pub vector_key: String,
    pub generation: String,
    pub embedding_chunk_id: String,
    pub embedding_version: String,
    pub owner_id: String,
    pub owner_revision: String,
    pub source_revision: String,
    pub source_refs_json: String,
    pub project_id: String,
    pub origin_kind: String,
    pub source_kind: Option<String>,
    pub conversation_session_id: Option<String>,
    pub source_observed_at: String,
    pub source_episode_id: Option<String>,
    pub rank: usize,
    pub distance: f64,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct RecallVectorMatches {
    pub nodes: Vec<RecallVectorMatch>,
    pub episodes: Vec<RecallVectorMatch>,
    pub diagnostics: Vec<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct RecallSourceEpisode {
    pub episode_id: String,
    pub revision: String,
    pub session_id: String,
    pub turn_id: Option<String>,
}
