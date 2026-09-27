//! Semantic projection: turns one source window into proposed graph facts.
//!
//! [`run_extractor`] is the entry point: the `meaning` stage reads the
//! window's passages ([`meaning`]), then `binding` stages tie new entities and
//! changes to existing graph nodes ([`binding`]). [`contracts`] holds the
//! input/output wire types stored with each projection window; the graph
//! validates and applies the output.

mod binding;
mod contract_data;
mod contracts;
#[cfg(test)]
mod format_pin;
mod meaning;
mod runner;

use contract_data::ExtractionContractData;
pub(crate) use contracts::{
    CandidateClaim, CandidateEvidence, CandidateSearchFuture, ClaimCondition, ClaimRequirement,
    CognitionCandidateSearch, ExtractAlias, ExtractCandidate, ExtractClaim, ExtractCorrection,
    ExtractInput, ExtractNode, ExtractOutput, ExtractRelation, ExtractSummary, NodeResolution,
    ProjectionContextUnit, ProjectionSourceSpan, ProjectionSourceUnit, QuoteRef,
};
pub use contracts::{CandidateSearchInput, CognitionVectorSearch, VectorSearchFuture};
pub(in crate::cognition) use meaning::{
    Meaning, Passage, meaning_prompt, meaning_to_output, source_passages, validate_meaning,
};
pub(in crate::cognition) use runner::StageFuture;
pub(super) use runner::{
    ExtractionRun, ExtractionRunInput, ExtractionStagePort, ProviderEvidence, RunEvidence,
    run_extractor,
};
