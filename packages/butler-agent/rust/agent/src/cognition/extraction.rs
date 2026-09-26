//! Semantic projection contracts and execution.

mod binding;
mod contract_data;
mod contracts;
mod meaning;
mod runner;

use contract_data::ExtractionContractData;
pub(crate) use contracts::{
    CandidateEvidence, CandidateSearchFuture, CandidateSearchInput, CognitionCandidateSearch,
    CognitionVectorSearch, ExtractAlias, ExtractCandidate, ExtractClaim, ExtractCorrection,
    ExtractInput, ExtractNode, ExtractOutput, ExtractRelation, ExtractSummary, NodeResolution,
    ProjectionContextUnit, ProjectionSourceSpan, ProjectionSourceUnit, QuoteRef,
    VectorSearchFuture,
};
pub(in crate::cognition) use meaning::{
    Meaning, Passage, meaning_prompt, meaning_to_output, source_passages, validate_meaning,
};
pub(in crate::cognition) use runner::StageFuture;
pub(super) use runner::{ExtractionRunInput, ExtractionStagePort, run_extractor};
