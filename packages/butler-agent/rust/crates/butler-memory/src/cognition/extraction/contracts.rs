//! Wire contracts of semantic projection: the extractor's input window
//! ([`ExtractInput`]), the graph facts it proposes ([`ExtractOutput`]), and the
//! candidate/vector search ports it binds names against.
//!
//! `ExtractInput` and `ExtractOutput` are persisted as
//! `memory_projection_windows.input_json` / `output_json`, so their field
//! order and names are a storage format.

use std::{future::Future, path::Path, pin::Pin};

use serde::{Deserialize, Serialize};

use crate::cognition::{CognitionResult, GenerationEmbedding};

pub(crate) type CandidateSearchFuture<'a> =
    Pin<Box<dyn Future<Output = CognitionResult<Vec<ExtractCandidate>>> + Send + 'a>>;

pub(crate) trait CognitionCandidateSearch: Send + Sync {
    fn search<'a>(&'a self, input: CandidateSearchInput<'a>) -> CandidateSearchFuture<'a>;
}
/// Future returned by [`CognitionVectorSearch::search`].
pub type VectorSearchFuture<'a> = Pin<
    Box<dyn Future<Output = CognitionResult<Vec<crate::cognition::graph::VectorHit>>> + Send + 'a>,
>;
/// Native adapter obligation: each hit must already be filtered to the selected
/// current generation's unit and digest before the graph's source-scope filter.
pub trait CognitionVectorSearch: Send + Sync {
    /// Nearest memory units for `input.cue` in the selected generation.
    fn search<'a>(&'a self, input: CandidateSearchInput<'a>) -> VectorSearchFuture<'a>;
}

/// One candidate or vector search: which generation to search and for what.
pub struct CandidateSearchInput<'a> {
    /// Butler data root holding the memory generations.
    pub source_root: &'a Path,
    /// Generation whose graph and vectors are searched.
    pub generation_id: &'a str,
    /// Embedding identity of that generation; `None` disables vector search.
    pub embedding: Option<&'a GenerationEmbedding>,
    /// Search text (an entity name or a change's words).
    pub cue: &'a str,
    /// Project the window is bound to, which scopes project candidates.
    pub bound_project_id: Option<&'a str>,
    /// Absolute deadline for the search in epoch milliseconds.
    pub deadline_epoch_millis: i64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(crate) struct ExtractInput {
    pub schema: String,
    pub episode_ref: String,
    pub revision: String,
    pub window_ref: String,
    pub bound_project_id: Option<String>,
    pub source_units: Vec<ProjectionSourceUnit>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_expansion: Option<f64>,
    pub context_units: Vec<ProjectionContextUnit>,
    pub candidates: Vec<ExtractCandidate>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(crate) struct ProjectionSourceUnit {
    #[serde(rename = "ref")]
    pub ref_id: String,
    pub text: String,
    pub role: String,
    pub observed_at: String,
    pub origin_kind: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(crate) struct ProjectionContextUnit {
    #[serde(rename = "ref")]
    pub ref_id: String,
    pub text: String,
    pub observed_at: String,
    pub basis: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_span: Option<ProjectionSourceSpan>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(crate) struct ProjectionSourceSpan {
    pub source_ref: String,
    pub byte_start: f64,
    pub byte_end: f64,
    pub focus_start: f64,
    pub focus_end: f64,
    pub prefix_bytes: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(crate) struct ExtractCandidate {
    #[serde(rename = "ref")]
    pub ref_id: String,
    #[serde(rename = "type")]
    pub node_type: String,
    pub label: String,
    pub aliases: Vec<String>,
    pub scope: String,
    pub project_id: Option<String>,
    #[serde(default)]
    pub claim: Option<CandidateClaim>,
    pub evidence: Vec<CandidateEvidence>,
}

impl ExtractCandidate {
    /// Entities and projects are identity nodes; everything else is a claim.
    pub(in crate::cognition) fn is_identity_node(&self) -> bool {
        self.node_type == "entity" || self.node_type == "project"
    }
}

/// The claim a candidate node states, with its subject and object nodes.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub(crate) struct CandidateClaim {
    pub statement: String,
    pub subject_ref: Option<String>,
    pub object_ref: Option<String>,
    pub relation: Option<String>,
    pub polarity: Option<String>,
    pub condition: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(crate) struct CandidateEvidence {
    #[serde(rename = "ref")]
    pub ref_id: String,
    pub text: String,
    pub observed_at: String,
    pub basis: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(crate) struct ExtractOutput {
    pub schema: String,
    pub window_ref: String,
    pub disposition: String,
    pub covered_unit_refs: Vec<String>,
    pub nodes: Vec<ExtractNode>,
    pub claims: Vec<ExtractClaim>,
    pub relations: Vec<ExtractRelation>,
    pub corrections: Vec<ExtractCorrection>,
    pub summary: Option<ExtractSummary>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(crate) struct QuoteRef {
    pub unit_ref: String,
    pub quote: String,
    pub occurrence: usize,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum NodeResolution {
    Create {
        provisional: bool,
        identity_scope: String,
    },
    Reuse {
        node_ref: String,
        reason: String,
        evidence: Vec<QuoteRef>,
    },
}
impl NodeResolution {
    pub(in crate::cognition) fn kind(&self) -> &'static str {
        match self {
            Self::Create { .. } => "create",
            Self::Reuse { .. } => "reuse",
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(crate) struct ExtractAlias {
    pub text: String,
    pub evidence: Vec<QuoteRef>,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(crate) struct ExtractNode {
    pub local_ref: String,
    #[serde(rename = "type")]
    pub node_type: String,
    pub label: String,
    pub resolution: NodeResolution,
    pub aliases: Vec<ExtractAlias>,
    pub evidence: Vec<QuoteRef>,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(crate) struct ExtractClaim {
    pub local_ref: String,
    #[serde(rename = "type")]
    pub claim_type: String,
    pub resolution: NodeResolution,
    pub statement: String,
    pub subject_ref: Option<String>,
    pub object_ref: Option<String>,
    pub speech_act: String,
    pub basis: String,
    pub polarity: String,
    pub condition: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requirement: Option<ClaimRequirement>,
    pub valid_from: Option<String>,
    pub valid_to: Option<String>,
    pub salience: String,
    pub evidence: Vec<QuoteRef>,
}

/// What a constraint claim requires: an action and the condition under which
/// it is necessary. Also stored as `memory_claims.requirement` JSON.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ClaimRequirement {
    pub action: String,
    pub condition: ClaimCondition,
}

/// A requirement's condition tree. An atom's subject is a planned node ref,
/// or `None` for a literal time or situation.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(untagged, deny_unknown_fields)]
pub(crate) enum ClaimCondition {
    Atom {
        subject: Option<String>,
        state: String,
    },
    Not {
        not: Box<ClaimCondition>,
    },
    All {
        all: Vec<ClaimCondition>,
    },
    Any {
        any: Vec<ClaimCondition>,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(crate) struct ExtractRelation {
    pub from_ref: String,
    pub to_ref: String,
    pub relation: String,
    pub claim_ref: String,
    pub evidence: Vec<QuoteRef>,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(crate) struct ExtractCorrection {
    pub previous_claim_ref: String,
    pub replacement_claim_ref: String,
    pub relation: String,
    pub effective_at: Option<String>,
    pub evidence: Vec<QuoteRef>,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(crate) struct ExtractSummary {
    pub text: String,
    pub evidence: Vec<QuoteRef>,
}
