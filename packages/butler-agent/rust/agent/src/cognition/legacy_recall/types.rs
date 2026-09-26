use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LegacyRecallRequest {
    pub cue: String,
    pub project_id: Option<String>,
    pub context: Option<LegacyRecallContext>,
    pub evidence_policy: Option<LegacyRecallEvidencePolicy>,
    pub ranking_policy: Option<LegacyRecallEvidencePolicy>,
    pub limit: Option<f64>,
    pub now: Option<f64>,
    pub min_score: Option<f64>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LegacyRecallContext {
    pub recent_context: Option<String>,
    pub active_task_summary: Option<String>,
    pub project_state: Option<String>,
    pub recent_artifacts: Vec<String>,
    pub recent_actions: Vec<String>,
    pub session_id: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LegacyRecallEvidencePolicy {
    pub evidence_required: Vec<LegacyRecallEvidenceRequirement>,
    pub retrieval_plan: Option<LegacyRecallPlan>,
    pub strategies: Vec<LegacyRecallStrategy>,
    pub min_evidence_confidence: Option<f64>,
    pub require_specific_memory: Option<bool>,
    pub tie_margin: Option<f64>,
    pub exclude_contradicted: Option<bool>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub(crate) struct LegacyRecallPlan {
    pub strategies: Vec<LegacyRecallStrategy>,
    pub evidence_required: Vec<LegacyRecallEvidenceRequirement>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum LegacyRecallStrategy {
    ReadRecentContext,
    QueryExactTranscript,
    SearchLexicalMemory,
    SearchVectorEpisode,
    ReadGraphMemory,
    ReadExplicitMemory,
    ReadTaskState,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum LegacyRecallEvidenceRequirement {
    ExactQuote,
    RecentTurnHit,
    TaskContinuity,
    ProjectMemoryHit,
    VectorEpisodeHit,
    ExplicitRuleHit,
    GraphRelationHit,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum LegacyRecallSource {
    HotCache,
    Vector,
    Graph,
    Explicit,
    Hybrid,
    ProjectMemory,
    TaskMemory,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum LegacyRecallOriginalSource {
    HotCache,
    ProjectMemory,
    TaskMemory,
    Rules,
    Graph,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LegacyRecallCorpus {
    pub nodes: Vec<LegacyRecallNode>,
    pub edges: Vec<LegacyRecallEdge>,
    pub candidates: Vec<LegacyRecallCandidate>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LegacyRecallNode {
    pub id: String,
    pub name: String,
    pub degree: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LegacyRecallEdge {
    pub source_id: String,
    pub target_id: String,
    pub weight: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LegacyRecallCandidate {
    pub id: String,
    pub summary: String,
    pub text: String,
    pub source: LegacyRecallSource,
    #[serde(rename = "originalSource")]
    pub original_source: Option<LegacyRecallOriginalSource>,
    pub provenance: Vec<String>,
    pub related_nodes: Vec<String>,
    pub timestamp: Option<f64>,
    pub frequency: Option<f64>,
    pub explicit_salience: Option<f64>,
    pub vector_similarity: Option<f64>,
    pub contextual_score: Option<f64>,
    pub superseded_by: Option<String>,
    pub contradicts: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub(crate) struct LegacyRecallScoreBreakdown {
    pub semantic_similarity: f64,
    pub lexical_match: f64,
    pub contextual_match: f64,
    pub graph_activation: f64,
    pub recency_score: f64,
    pub frequency_score: f64,
    pub explicit_salience: f64,
    pub evidence_confidence: f64,
    pub decision_preference_boost: f64,
    pub hub_penalty: f64,
    pub conflict_penalty: f64,
    pub stale_superseded_penalty: f64,
    pub total: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(crate) struct LegacyRecallItem {
    pub summary: String,
    pub confidence: f64,
    pub source: LegacyRecallSource,
    #[serde(rename = "originalSource")]
    pub original_source: Option<LegacyRecallOriginalSource>,
    pub provenance: Vec<String>,
    pub related_nodes: Vec<String>,
    pub score_breakdown: LegacyRecallScoreBreakdown,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(crate) struct LegacyRecallResponse {
    pub cue: String,
    pub seeds: Vec<String>,
    pub items: Vec<LegacyRecallItem>,
    pub abstained: bool,
    pub diagnostics: Vec<String>,
}
