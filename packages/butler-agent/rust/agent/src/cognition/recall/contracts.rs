//! Query-local recall graph and episode ranking values.

mod operation;
pub(crate) use operation::*;

use indexmap::IndexMap;
use serde::Serialize;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct RecallEdge {
    pub edge_id: String,
    pub source_node_id: String,
    pub target_node_id: String,
    pub relation: String,
    pub claim_node_id: Option<String>,
    pub support: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct RecallAssociationStep {
    pub from: String,
    pub relation: String,
    pub to: String,
    pub traversed_reverse: bool,
}

#[derive(Debug)]
pub(crate) struct EligibleAdjacency {
    pub edges: Vec<RecallEdge>,
    pub truncated: bool,
}

#[derive(Debug)]
pub(crate) struct IdentityMembers {
    pub members: Vec<String>,
    pub partial: bool,
}

#[derive(Debug)]
pub(crate) struct GraphExpansion {
    pub relevance: IndexMap<String, f64>,
    pub paths: IndexMap<String, Vec<RecallAssociationStep>>,
    #[cfg(test)]
    pub edges: Vec<RecallEdge>,
    pub coverage_codes: Vec<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RecallResultChannel {
    Graph,
    Vector,
    Lexical,
    Context,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Salience {
    High,
    Normal,
    Unspecified,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TimeBasis {
    Conversation,
    Event,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct EpisodeRankInput {
    pub episode_id: String,
    pub conversation_at: Option<String>,
    pub event_at: Option<String>,
    pub session_id: Option<String>,
    pub graph_rank: Option<f64>,
    pub lexical_rank: Option<f64>,
    pub vector_rank: Option<f64>,
    pub context_rank: Option<f64>,
    pub query_relevance: Option<f64>,
    pub explicit_priority: Option<bool>,
    pub salience: Option<Salience>,
    pub support_count: Option<f64>,
    pub half_life_days: Option<f64>,
}

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct ExecutedEpisodeChannels {
    pub graph: bool,
    pub vector: bool,
    pub lexical: bool,
    pub context: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct RankedEpisode {
    pub input: EpisodeRankInput,
    pub score: f64,
    pub channels: Vec<RecallResultChannel>,
}

#[derive(Debug, PartialEq)]
pub(crate) struct FusedEpisodeCandidates {
    pub episode_ids: Vec<String>,
    pub candidate_limit: bool,
}
