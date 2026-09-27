use std::{future::Future, path::Path, pin::Pin};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::cognition::{CognitionResult, GenerationEmbedding};

pub(crate) type CandidateSearchFuture<'a> =
    Pin<Box<dyn Future<Output = CognitionResult<Vec<ExtractCandidate>>> + Send + 'a>>;

pub(crate) trait CognitionCandidateSearch: Send + Sync {
    fn search<'a>(&'a self, input: CandidateSearchInput<'a>) -> CandidateSearchFuture<'a>;
}
pub(crate) type VectorSearchFuture<'a> = Pin<
    Box<dyn Future<Output = CognitionResult<Vec<crate::cognition::graph::VectorHit>>> + Send + 'a>,
>;
/// Native adapter obligation: each hit must already be filtered to the selected
/// current generation's unit and digest before the graph's source-scope filter.
pub(crate) trait CognitionVectorSearch: Send + Sync {
    fn search<'a>(&'a self, input: CandidateSearchInput<'a>) -> VectorSearchFuture<'a>;
}

pub(crate) struct CandidateSearchInput<'a> {
    pub source_root: &'a Path,
    pub generation_id: &'a str,
    pub embedding: Option<&'a GenerationEmbedding>,
    pub cue: &'a str,
    pub bound_project_id: Option<&'a str>,
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
    pub claim: Option<Value>,
    pub evidence: Vec<CandidateEvidence>,
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
    pub requirement: Option<Value>,
    pub valid_from: Option<String>,
    pub valid_to: Option<String>,
    pub salience: String,
    pub evidence: Vec<QuoteRef>,
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
