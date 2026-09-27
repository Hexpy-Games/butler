//! Shared semantic seed ranking for projection and later public recall.

mod contracts;
mod expansion;
mod ranking;
mod semantic;
#[cfg(test)]
mod tests;

pub(crate) use contracts::{
    EligibleAdjacency, GraphExpansion, IdentityMembers, IdentityMembersResult, IdentityReadScope,
    IdentityResolution, IdentitySourceBinding, InterpretationStatus, RecallAdmittedChannels,
    RecallAssociationStep, RecallCoverage, RecallCoverageLane, RecallCoverageState, RecallEdge,
    RecallEvidence, RecallEvidenceRelation, RecallEvidenceSupport, RecallInterpretation,
    RecallProjectFilter, RecallReadArgs, RecallRequest, RecallRequirement, RecallResponse,
    RecallResultItem, RecallRuntime, RecallScope, RecallSourceEpisode, RecallSourceKind,
    RecallStatus, RecallTime, RecallTimeBasis, RecallVectorMatch, RecallVectorMatches,
};
pub(in crate::cognition) use contracts::{
    EpisodeRankInput, ExecutedEpisodeChannels, RankedEpisode, RecallResultChannel, Salience,
    TimeBasis,
};
pub(in crate::cognition) use expansion::expand_graph;
pub(in crate::cognition) use ranking::{
    diversify_by_session, fuse_episode_candidates, rank_episodes,
};

pub(in crate::cognition) use semantic::{
    Channel, RankedCandidate, SemanticSelection, rank_aliases, rank_lexical, select_semantic_seeds,
};
